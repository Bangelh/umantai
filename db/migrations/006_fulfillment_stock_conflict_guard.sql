-- =============================================================================
--  006 — BLOQUEO DE FULFILLMENT CUANDO EL PAGO APROBADO NO TIENE STOCK
--
--  PROBLEMA QUE RESUELVE
--  La migración 005 dejó CASO A (primer pago que confirma) con `needsReview`
--  HARDCODEADO en FALSE. Cuando el pedido venía de `expired` con la reserva ya
--  liberada y `inventory_rereserve_order()` no podía retener stock (no hay
--  disponible), la función igual confirmaba el pedido y escribía:
--      status = 'confirmed', payment_status = 'paid',
--      reservation_released = TRUE, stockConflict = TRUE,
--      stockConflictReason = 'insufficient_stock', rereservedLines = 0,
--      needsReview = FALSE              ← el problema
--  Resultado (demostrado en runtime con UM-2026-001016): un pedido pagado, sin
--  stock reservado, quedaba como un `confirmed` normal. El webhook avisaba a la
--  tienda "prepáralo", el kiosco permitía emitir PIN y `inventory_commit_order()`
--  llegaba a aplicar un `sale` sobre una reserva que ya no existía (consumiendo la
--  retención de OTRO pedido). El conflicto era invisible para la operación.
--
--  QUÉ HACE ESTA MIGRACIÓN (ALTERNATIVA A — auditada)
--   1. `confirm_order_payment` (redefine la de 005): en CASO A, `needsReview` pasa a
--      ser `v_stock_conflict`. El resto de las ramas (A normal, B retry no-op, C
--      segundo pago) queda IDÉNTICO. El hecho económico se preserva siempre:
--      `payment_status='paid'`, `payment_reference`, `receivedPayments`, y NO se
--      crea stock inexistente ni se toca `inventory` cuando la rereserva falla.
--   2. `mark_order_ready_for_pickup` (redefine la de 003): rechaza con
--      `order_requires_review` si `metadata.payment.stockConflict` o `needsReview`
--      son TRUE. No emite PIN ni cambia estado.
--   3. `inventory_commit_order` (redefine la de 001): defensa en profundidad —
--      rechaza con `order_requires_review` ANTES de aplicar cualquier movimiento,
--      así ningún camino (redeem del PIN, `markPickedUp`/`markDelivered`) consolida
--      stock de un pedido en conflicto.
--   4. `redeem_pickup_code_verified` (redefine la de 003): si el commit choca con la
--      guarda, devuelve `ok=false, error_code='order_requires_review'` (no un error
--      duro) y revierte el canje — el PIN sigue vigente y no se consume stock.
--   5. BACKFILL acotado: pedidos YA afectados (`stockConflict=true` y `needsReview`
--      distinto de true) pasan a `needsReview=true`. Solo se toca esa clave de
--      `metadata.payment`.
--
--  ADITIVA / REVERSIBLE: CREATE OR REPLACE FUNCTION + un UPDATE de metadata puntual.
--  IDEMPOTENTE: re-ejecutarla no cambia nada.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
--  1. confirm_order_payment — CASO A marca needsReview ante conflicto de stock
--     (idéntica a 005 salvo la línea `'needsReview'`).
-- -----------------------------------------------------------------------------
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
  -- NO-OP TOTAL: se devuelve el pedido sin ningún UPDATE. Cubre también el retry
  -- de un pago que dejó `stockConflict`/`needsReview`: no re-reserva ni borra flags.
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
                                             -- ⬇ CAMBIO 006: un conflicto de stock EXIGE
                                             -- revisión humana (antes era FALSE fijo).
                                             'needsReview',         v_stock_conflict,
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
  --  (idéntico a 005: NO confirma, NO toca stock/estado; preserva ambos pagos).
  -- ═══════════════════════════════════════════════════════════════════════════
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
  'Confirma el pago de un pedido. Idempotente: reintento del mismo pago = no-op; un segundo pago aprobado distinto NO confirma ni sobrescribe la referencia primaria (marca duplicatePayment/needsReview). Si el pago es aprobado pero la re-reserva de stock falla, confirma igual, marca stockConflict=true y needsReview=true (006) y el fulfillment queda bloqueado hasta revisión.';


-- -----------------------------------------------------------------------------
--  2. mark_order_ready_for_pickup — rechaza pedidos en conflicto/revisión
--     (resto idéntico a 003).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mark_order_ready_for_pickup(
  p_order_id     UUID,
  p_locker_code  TEXT DEFAULT NULL,
  p_locker_slot  TEXT DEFAULT NULL,
  p_ttl          INTERVAL DEFAULT INTERVAL '7 days',
  p_max_attempts INTEGER DEFAULT 5,
  p_actor        TEXT DEFAULT 'kiosk'
)
RETURNS pickup_codes
LANGUAGE plpgsql
AS $$
DECLARE
  v_order orders;
  v_code  pickup_codes;
BEGIN
  SELECT * INTO v_order
    FROM orders
   WHERE id = p_order_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- ⬇ CAMBIO 006: un cobro aprobado que no pudo retener stock (o cualquier cobro
  -- que quedó pendiente de revisión) NO puede avanzar a preparación. Es la barrera
  -- autoritativa server-side: no alcanza con esconder un botón en el UI.
  IF (v_order.metadata -> 'payment' ->> 'stockConflict') = 'true'
     OR (v_order.metadata -> 'payment' ->> 'needsReview') = 'true' THEN
    RAISE EXCEPTION 'order_requires_review: el pedido % tiene un conflicto de stock/revisión pendiente', v_order.order_number
      USING ERRCODE = '23514',
            HINT    = 'Repón/libera stock o reembolsa, limpia metadata.payment.stockConflict/needsReview y recién entonces prepara el pedido.';
  END IF;

  -- Sin pago confirmado no se entrega mercadería.
  IF v_order.payment_status <> 'paid' THEN
    RAISE EXCEPTION 'order_not_paid: el pedido % está en % ', v_order.order_number, v_order.payment_status
      USING ERRCODE = '23514',
            HINT    = 'Sólo se prepara mercadería ya cobrada.';
  END IF;

  IF v_order.status NOT IN ('confirmed', 'preparing') THEN
    RAISE EXCEPTION 'invalid_order_transition: % -> ready_for_pickup', v_order.status
      USING ERRCODE = '23514';
  END IF;

  PERFORM set_config('app.actor', COALESCE(NULLIF(p_actor, ''), 'kiosk'), TRUE);

  -- Paso intermedio obligatorio de la máquina de estados (queda auditado en
  -- order_status_history: confirmed → preparing → ready_for_pickup).
  IF v_order.status = 'confirmed' THEN
    UPDATE orders SET status = 'preparing' WHERE id = p_order_id;
  END IF;

  UPDATE orders
     SET status = 'ready_for_pickup',
         locker_code = COALESCE(p_locker_code, locker_code)
   WHERE id = p_order_id;

  SELECT * INTO v_code
    FROM issue_pickup_code(p_order_id, p_locker_code, p_locker_slot, p_ttl, p_max_attempts);

  RETURN v_code;
END $$;


-- -----------------------------------------------------------------------------
--  3. inventory_commit_order — defensa en profundidad antes de tocar stock
--     (resto idéntico a 001).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION inventory_commit_order(
  p_order_id UUID,
  p_reason   TEXT DEFAULT 'picked_up'
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_item  RECORD;
  v_count INTEGER := 0;
BEGIN
  -- ⬇ CAMBIO 006: no se consolida stock de un pedido con conflicto/revisión. Sin
  -- esto, un `sale` sobre una reserva ya liberada descontaría la retención de OTRO
  -- pedido (el selector de abajo solo mira que exista un movimiento 'reservation'
  -- histórico, no que siga vivo). Se lanza ANTES de aplicar cualquier movimiento.
  IF EXISTS (
    SELECT 1 FROM orders o
     WHERE o.id = p_order_id
       AND ((o.metadata -> 'payment' ->> 'stockConflict') = 'true'
         OR (o.metadata -> 'payment' ->> 'needsReview') = 'true')
  ) THEN
    RAISE EXCEPTION 'order_requires_review: el pedido % tiene un conflicto de stock/revisión pendiente', p_order_id
      USING ERRCODE = '23514',
            HINT    = 'No se puede entregar: resuelve el conflicto y limpia los flags primero.';
  END IF;

  FOR v_item IN
    SELECT oi.id, oi.product_slug, oi.variant_key, oi.quantity
      FROM order_items oi
     WHERE oi.order_id = p_order_id
       AND EXISTS (
             SELECT 1 FROM inventory_movements m
              WHERE m.order_item_id = oi.id AND m.movement_type = 'reservation')
       AND NOT EXISTS (
             SELECT 1 FROM inventory_movements m
              WHERE m.order_item_id = oi.id AND m.movement_type = 'sale')
     ORDER BY oi.line_number
  LOOP
    PERFORM inventory_apply_movement(
      p_product_slug    => v_item.product_slug,
      p_variant_key     => v_item.variant_key,
      p_movement_type   => 'sale',
      p_on_hand_delta   => -v_item.quantity,
      p_reserved_delta  => -v_item.quantity,
      p_location_code   => 'MAIN',
      p_order_id        => p_order_id,
      p_order_item_id   => v_item.id,
      p_reason          => p_reason,
      p_performed_by    => 'system',
      p_idempotency_key => 'sale:' || p_order_id::TEXT || ':' || v_item.id::TEXT
    );
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END $$;


-- -----------------------------------------------------------------------------
--  4. redeem_pickup_code_verified — canje protegido, error de negocio claro
--     (resto idéntico a 003).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION redeem_pickup_code_verified(
  p_code        TEXT,
  p_redeemed_by TEXT DEFAULT NULL,
  p_device_id   TEXT DEFAULT NULL,
  p_ip          TEXT DEFAULT NULL
)
RETURNS TABLE (
  ok              BOOLEAN,
  error_code      TEXT,
  pickup_code_id  UUID,
  order_id        UUID,
  order_number    TEXT,
  locker_code     TEXT,
  locker_slot     TEXT,
  committed_lines INTEGER
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_window       CONSTANT INTERVAL := INTERVAL '10 minutes';
  v_max_actor    CONSTANT INTEGER  := 15;
  v_max_global   CONSTANT INTEGER  := 90;
  v_normalized   TEXT;
  v_actor_fails  INTEGER;
  v_global_fails INTEGER;
  v_redeem       RECORD;
  v_committed    INTEGER := 0;
BEGIN
  v_normalized := upper(btrim(COALESCE(p_code, '')));

  SELECT count(*) INTO v_actor_fails
    FROM pickup_attempts a
   WHERE a.created_at > NOW() - v_window
     AND a.outcome <> 'ok'
     AND (
          (p_device_id IS NOT NULL AND a.device_id = p_device_id)
       OR (p_ip        IS NOT NULL AND a.ip        = p_ip)
     );

  SELECT count(*) INTO v_global_fails
    FROM pickup_attempts a
   WHERE a.created_at > NOW() - v_window
     AND a.outcome <> 'ok';

  IF v_actor_fails >= v_max_actor OR v_global_fails >= v_max_global THEN
    INSERT INTO pickup_attempts (code_attempt, outcome, device_id, ip)
    VALUES (v_normalized, 'throttled', p_device_id, p_ip);

    RETURN QUERY
      SELECT FALSE, 'pickup_rate_limited'::TEXT, NULL::UUID, NULL::UUID,
             NULL::TEXT, NULL::TEXT, NULL::TEXT, 0;
    RETURN;
  END IF;

  -- Sub-bloque: el canje y el commit van juntos. Si el commit choca con la guarda
  -- de conflicto (order_requires_review) revierte el canje → el PIN NO se consume
  -- y no se toca inventario; se devuelve un error de negocio claro.
  BEGIN
    SELECT * INTO v_redeem
      FROM redeem_pickup_code(p_code, p_redeemed_by);

    INSERT INTO pickup_attempts (code_attempt, outcome, device_id, ip)
    VALUES (v_normalized, COALESCE(v_redeem.error_code, 'ok'), p_device_id, p_ip);

    IF NOT v_redeem.ok THEN
      RETURN QUERY
        SELECT FALSE, v_redeem.error_code, NULL::UUID, NULL::UUID,
               NULL::TEXT, NULL::TEXT, NULL::TEXT, 0;
      RETURN;
    END IF;

    -- La entrega física consolida la reserva. Si acá falta stock, esto lanza
    -- `insufficient_stock` y se revierte TODO: mejor un PIN que sigue sirviendo que
    -- un inventario mentiroso.
    v_committed := inventory_commit_order(v_redeem.order_id, 'picked_up');

    RETURN QUERY
      SELECT TRUE, NULL::TEXT, v_redeem.pickup_code_id, v_redeem.order_id,
             v_redeem.order_number, v_redeem.locker_code, v_redeem.locker_slot, v_committed;
    RETURN;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%order_requires_review%' THEN
      INSERT INTO pickup_attempts (code_attempt, outcome, device_id, ip)
      VALUES (v_normalized, 'order_requires_review', p_device_id, p_ip);

      RETURN QUERY
        SELECT FALSE, 'order_requires_review'::TEXT, NULL::UUID, NULL::UUID,
               NULL::TEXT, NULL::TEXT, NULL::TEXT, 0;
      RETURN;
    END IF;
    RAISE;
  END;
END $$;


-- -----------------------------------------------------------------------------
--  5. BACKFILL — pedidos YA afectados por el bug (stockConflict sin needsReview)
--
--  Alcance EXACTO: filas donde `metadata.payment.stockConflict = true` y
--  `metadata.payment.needsReview` NO es `true`. Única fuente posible de
--  `stockConflict=true` es CASO A con la re-reserva fallida, así que todas esas
--  filas necesitan revisión por definición. NO se toca `status`, `payment_status`,
--  `payment_reference`, `confirmed_at`, `reservation_released` ni el inventario.
--  Idempotente: una segunda corrida no encuentra filas.
-- -----------------------------------------------------------------------------
UPDATE orders o
   SET metadata = jsonb_set(o.metadata, '{payment,needsReview}', 'true'::jsonb, TRUE)
 WHERE (o.metadata -> 'payment' ->> 'stockConflict') = 'true'
   AND COALESCE(o.metadata -> 'payment' ->> 'needsReview', 'false') <> 'true';

COMMIT;

-- =============================================================================
--  VERIFICACIÓN (opcional, en rama de desarrollo; NO ejecutar en Preview sin
--  autorización). Ensayo en seco dentro de una transacción que se revierte:
--
--   BEGIN;
--     -- CASO A con conflicto: needsReview debe quedar TRUE
--     SELECT (confirm_order_payment('UM-2026-000000','test','account_money',749,'PEN',
--              '{"status":"approved","statusDetail":"accredited"}'::jsonb)).*;
--     ROLLBACK;
--
--   -- Guarda de ready (debe lanzar order_requires_review):
--   -- SELECT mark_order_ready_for_pickup('<order_id>');
--
--   -- Guarda de commit (debe lanzar order_requires_review):
--   -- SELECT inventory_commit_order('<order_id>');
-- =============================================================================
