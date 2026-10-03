-- =============================================================================
--  005 — GUARDA CONTRA SEGUNDO PAGO APROBADO (pago doble)
--
--  PROBLEMA QUE RESUELVE
--  `confirm_order_payment()` (migración 002) confirmaba el pedido y, además, en
--  CADA llamada hacía:
--      payment_reference = COALESCE(p_payment_id, payment_reference)
--      ... jsonb_build_object('lastPaymentId', p_payment_id, ... 'needsReview',
--                             NOT v_confirmable AND NOT v_already_paid)
--  Consecuencia demostrada con `UM-2026-001011`: un SEGUNDO Payment ID aprobado
--  distinto sobre un pedido YA pagado
--    · sobrescribía `orders.payment_reference` (se perdía el pago primario),
--    · sobrescribía `payment_method`,
--    · reescribía `metadata.payment.lastPaymentId`,
--    · dejaba `needsReview = false` (nadie se enteraba),
--    · y NO marcaba que había un cobro duplicado.
--  El stock/pedido sí eran idempotentes (v_confirmable = false), pero la
--  EVIDENCIA del primer cobro se perdía de forma silenciosa.
--
--  QUÉ HACE ESTA MIGRACIÓN
--  Reemplaza SOLO la función `confirm_order_payment` con tres ramas explícitas:
--
--   CASO A — primer pago aprobado (pedido NO pagado): comportamiento actual
--            intacto (confirmar, re-reservar si aplica, flags en falso).
--   CASO B — reintento del MISMO pago primario sobre un pedido YA pagado:
--            NO-OP TOTAL (sin UPDATE alguno). No cambia status, versión,
--            inventario ni metadata; ni siquiera `updated_at`.
--   CASO C — SEGUNDO Payment ID aprobado DISTINTO sobre un pedido YA pagado:
--            NO confirma, NO toca stock/status/versión, NO sobrescribe la
--            referencia primaria; preserva AMBOS pagos en
--            `metadata.payment.receivedPayments` (deduplicado por id) y marca
--            `duplicatePayment` / `needsReview`. Si el monto o la moneda no
--            coinciden, además `amountMismatch = true`.
--
--  NO crea una tabla nueva de pagos: `metadata.payment.receivedPayments` es
--  suficiente para este MVP y evita un cambio de esquema mayor.
--
--  ADITIVA / REVERSIBLE: `CREATE OR REPLACE FUNCTION`, sin tocar tablas ni datos.
--  IDEMPOTENTE: se puede re-ejecutar sin efectos secundarios.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION confirm_order_payment(
  p_order_number     TEXT,                             -- == payment.external_reference
  p_payment_id       TEXT,                             -- id del pago en Mercado Pago
  p_payment_method   TEXT     DEFAULT NULL,
  p_paid_amount      NUMERIC  DEFAULT NULL,            -- lo que MP dice haber cobrado
  p_currency         TEXT     DEFAULT NULL,
  p_payment_metadata JSONB    DEFAULT '{}'::jsonb,     -- snapshot del pago (status, detalle…)
  p_location_code    TEXT     DEFAULT 'MAIN',
  p_actor            TEXT     DEFAULT 'mercadopago:webhook'
)
RETURNS orders
LANGUAGE plpgsql
AS $$
DECLARE
  v_order          orders;
  v_amounts_match  BOOLEAN;
  v_already_paid   BOOLEAN;
  v_confirmable    BOOLEAN;
  v_rereserved     INTEGER := 0;
  v_stock_conflict BOOLEAN := FALSE;
  v_stock_error    TEXT;
  v_payment_meta   JSONB;      -- metadata.payment actual (objeto, nunca escalar/array)
  v_incoming       JSONB;      -- entrada normalizada del pago entrante
  v_received       JSONB;      -- lista receivedPayments resultante
  v_primary_id     TEXT;       -- id del pago primario (el que confirmó el pedido)
  v_primary_entry  JSONB;      -- entry de respaldo para el pago primario
  v_is_known_dup   BOOLEAN;
BEGIN
  SELECT * INTO v_order
    FROM orders
   WHERE order_number = p_order_number
     FOR UPDATE;

  -- Pago de otro entorno (sandbox apuntando a la base de producción) o
  -- external_reference que no es nuestro. No es un error del que MP deba enterarse.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Queda registrado en order_status_history.changed_by.
  PERFORM set_config('app.actor', COALESCE(NULLIF(p_actor, ''), 'mercadopago:webhook'), TRUE);

  v_amounts_match := (p_paid_amount IS NULL OR p_paid_amount = v_order.total)
                     AND (p_currency IS NULL OR upper(p_currency) = upper(v_order.currency));
  v_already_paid  := v_order.payment_status = 'paid';
  v_confirmable   := NOT v_already_paid
                     AND v_order.status IN ('pending_payment', 'expired')
                     AND v_amounts_match;

  -- `jsonb_typeof` en vez de COALESCE: si alguien dejó `metadata.payment` en JSON
  -- `null`, concatenar contra ese escalar envolvería todo en un array.
  v_payment_meta := CASE
                      WHEN jsonb_typeof(v_order.metadata -> 'payment') = 'object'
                      THEN v_order.metadata -> 'payment'
                      ELSE '{}'::jsonb
                    END;

  -- Entrada normalizada del pago entrante. `jsonb_strip_nulls` garantiza que la
  -- entrada NUNCA lleve claves con valor null: no se inventan datos ausentes.
  v_incoming := jsonb_strip_nulls(jsonb_build_object(
    'id',              p_payment_id,
    'amount',          p_paid_amount,
    'currency',        p_currency,
    'paymentMethodId', COALESCE(NULLIF(p_payment_metadata ->> 'paymentMethodId', ''),
                                NULLIF(p_payment_method, '')),
    'paymentTypeId',   NULLIF(p_payment_metadata ->> 'paymentTypeId', ''),
    'status',          NULLIF(p_payment_metadata ->> 'status', ''),
    'statusDetail',    NULLIF(p_payment_metadata ->> 'statusDetail', ''),
    'dateApproved',    NULLIF(p_payment_metadata ->> 'dateApproved', ''),
    'receivedAt',      NOW()
  ));

  -- ── CASO B — reintento del MISMO pago primario sobre un pedido ya pagado ────
  -- NO-OP TOTAL: se devuelve el pedido sin ningún UPDATE (no cambia version,
  -- updated_at, inventario ni metadata). "Pago primario" = `payment_reference`
  -- o, si faltara, la primera entrada de `receivedPayments`.
  IF v_already_paid THEN
    v_primary_id := COALESCE(
      NULLIF(v_order.payment_reference, ''),
      v_payment_meta -> 'receivedPayments' -> 0 ->> 'id'
    );

    IF p_payment_id IS NOT NULL AND p_payment_id = v_primary_id THEN
      RETURN v_order;
    END IF;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  CASO A — primer pago aprobado que SÍ confirma el pedido
  -- ═══════════════════════════════════════════════════════════════════════════
  IF v_confirmable THEN
    -- El pago entrante ES el primario: se marca explícitamente.
    v_received := jsonb_build_array(v_incoming || jsonb_build_object('primary', TRUE));

    IF v_order.reservation_released THEN
      BEGIN
        v_rereserved := inventory_rereserve_order(v_order.id, p_location_code);
      EXCEPTION WHEN OTHERS THEN
        -- Bloque anidado: el rollback llega hasta acá, así que no queda una reserva
        -- a medias. La confirmación de más abajo SÍ se aplica.
        v_stock_conflict := TRUE;
        v_stock_error    := SQLERRM;
      END;
    END IF;

    UPDATE orders
       SET payment_reference      = COALESCE(p_payment_id, payment_reference),
           payment_method         = COALESCE(p_payment_method, payment_method),
           payment_status         = 'paid'::payment_status,
           status                 = 'confirmed'::order_status,
           reservation_expires_at = NULL,
           reservation_released   = CASE WHEN v_stock_conflict THEN TRUE ELSE FALSE END,
           metadata               = jsonb_set(
                                      COALESCE(metadata, '{}'::jsonb),
                                      '{payment}',
                                      v_payment_meta
                                        || COALESCE(p_payment_metadata, '{}'::jsonb)
                                        || jsonb_build_object(
                                             'receivedPayments',    v_received,
                                             'lastPaymentId',       p_payment_id,
                                             'lastPaymentAmount',   p_paid_amount,
                                             'lastPaymentCurrency', p_currency,
                                             'lastPaymentAt',       NOW(),
                                             'amountMismatch',      FALSE,
                                             'duplicatePayment',    FALSE,
                                             'needsReview',         FALSE,
                                             'stockConflict',       v_stock_conflict,
                                             'stockConflictReason', v_stock_error,
                                             'rereservedLines',     v_rereserved
                                           ),
                                      TRUE
                                    )
     WHERE id = v_order.id
     RETURNING * INTO v_order;

    RETURN v_order;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  Pedido NO pagado pero NO confirmable (monto/moneda no cuadran, o el estado
  --  ya no permite confirmar): comportamiento previo, sin tocar estado ni stock.
  -- ═══════════════════════════════════════════════════════════════════════════
  IF NOT v_already_paid THEN
    UPDATE orders
       SET metadata = jsonb_set(
                        COALESCE(metadata, '{}'::jsonb),
                        '{payment}',
                        v_payment_meta
                          || COALESCE(p_payment_metadata, '{}'::jsonb)
                          || jsonb_build_object(
                               'lastPaymentId',       p_payment_id,
                               'lastPaymentAmount',   p_paid_amount,
                               'lastPaymentCurrency', p_currency,
                               'lastPaymentAt',       NOW(),
                               'amountMismatch',      NOT v_amounts_match,
                               'needsReview',         TRUE
                             ),
                        TRUE
                      )
     WHERE id = v_order.id
     RETURNING * INTO v_order;

    RETURN v_order;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  CASO C — SEGUNDO Payment ID aprobado DISTINTO sobre un pedido YA pagado
  --
  --  NO confirma, NO toca stock, status, versión ni la referencia primaria. Solo
  --  deja constancia: preserva ambos pagos en `receivedPayments` (deduplicado) y
  --  marca `duplicatePayment` / `needsReview` (y `amountMismatch` si no cuadra).
  -- ═══════════════════════════════════════════════════════════════════════════

  -- Si el pedido se pagó ANTES de que existiera `receivedPayments`, se siembra el
  -- historial con el pago primario que YA conocemos (`payment_reference` + los
  -- datos del primer pago que quedaron en metadata.payment). Nunca se inventan.
  v_received := CASE
                  WHEN jsonb_typeof(v_payment_meta -> 'receivedPayments') = 'array'
                  THEN v_payment_meta -> 'receivedPayments'
                  ELSE '[]'::jsonb
                END;

  v_primary_id := COALESCE(
    NULLIF(v_order.payment_reference, ''),
    v_received -> 0 ->> 'id'
  );

  IF v_primary_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_received) e WHERE e ->> 'id' = v_primary_id
     ) THEN
    v_primary_entry := jsonb_strip_nulls(jsonb_build_object(
      'id',              v_primary_id,
      'amount',          v_payment_meta -> 'lastPaymentAmount',
      'currency',        v_payment_meta -> 'lastPaymentCurrency',
      'paymentMethodId', COALESCE(NULLIF(v_payment_meta ->> 'paymentMethodId', ''),
                                  NULLIF(v_order.payment_method, '')),
      'paymentTypeId',   NULLIF(v_payment_meta ->> 'paymentTypeId', ''),
      'status',          NULLIF(v_payment_meta ->> 'status', ''),
      'statusDetail',    NULLIF(v_payment_meta ->> 'statusDetail', ''),
      'dateApproved',    NULLIF(v_payment_meta ->> 'dateApproved', ''),
      'receivedAt',      v_payment_meta -> 'lastPaymentAt',
      'primary',         TRUE
    ));
    v_received := v_received || jsonb_build_array(v_primary_entry);
  END IF;

  -- Deduplicación por Payment ID: reenviar el mismo segundo pago no lo duplica.
  v_is_known_dup := p_payment_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_received) e WHERE e ->> 'id' = p_payment_id
    );

  IF NOT v_is_known_dup THEN
    v_received := v_received || jsonb_build_array(v_incoming);
  END IF;

  -- OJO: NO se tocan `payment_reference`, `payment_method`, `status`,
  -- `payment_status`, `confirmed_at`, la reserva ni el inventario. Como el status
  -- no cambia, `enforce_order_status_transition` NO incrementa `version`. El único
  -- sello técnico que cambia es `updated_at` (trigger set_updated_at).
  UPDATE orders
     SET metadata = jsonb_set(
                      COALESCE(metadata, '{}'::jsonb),
                      '{payment}',
                      v_payment_meta
                        || COALESCE(p_payment_metadata, '{}'::jsonb)
                        || jsonb_build_object(
                             'receivedPayments',    v_received,
                             'lastPaymentId',       p_payment_id,
                             'lastPaymentAmount',   p_paid_amount,
                             'lastPaymentCurrency', p_currency,
                             'lastPaymentAt',       NOW(),
                             'amountMismatch',      NOT v_amounts_match,
                             'duplicatePayment',    v_amounts_match,
                             'needsReview',         TRUE
                           ),
                      TRUE
                    )
   WHERE id = v_order.id
   RETURNING * INTO v_order;

  RETURN v_order;
END $$;

COMMENT ON FUNCTION confirm_order_payment(TEXT, TEXT, TEXT, NUMERIC, TEXT, JSONB, TEXT, TEXT) IS
  'Confirma el pago de un pedido. Idempotente: reintento del mismo pago = no-op; un segundo pago aprobado distinto NO confirma ni sobrescribe la referencia primaria, se marca duplicatePayment/needsReview y se preserva en metadata.payment.receivedPayments.';

COMMIT;

-- =============================================================================
--  VERIFICACIÓN (opcional, en tu rama de desarrollo; NO ejecutar en Preview sin
--  autorización). Ensayo en seco dentro de una transacción que se revierte:
--
--   BEGIN;
--     -- 1er pago
--     SELECT (confirm_order_payment('UM-2026-001011', '181116819289', 'account_money',
--                                   749, 'PEN',
--                                   '{"status":"approved","statusDetail":"accredited"}'::jsonb)).payment_reference;
--     -- 2do pago distinto: la referencia primaria NO debe cambiar
--     SELECT payment_reference, (metadata->'payment'->>'duplicatePayment') AS dup,
--            (metadata->'payment'->>'needsReview')     AS review,
--            jsonb_array_length(metadata->'payment'->'receivedPayments') AS n
--       FROM (SELECT (confirm_order_payment('UM-2026-001011', '182124944920', 'account_money',
--                                           749, 'PEN',
--                                           '{"status":"approved","statusDetail":"accredited"}'::jsonb)).*) s;
--   ROLLBACK;
-- =============================================================================
