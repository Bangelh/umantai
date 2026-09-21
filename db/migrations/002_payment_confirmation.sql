-- =============================================================================
--  002 — CONFIRMACIÓN DE PAGO TARDÍO (Mercado Pago / Checkout Pro)
--
--  PROBLEMA QUE RESUELVE
--  `expire_stale_orders()` libera el stock y marca el pedido como `expired` cuando
--  vence la reserva. Pero Mercado Pago puede aprobar el pago DESPUÉS de ese momento
--  (Yape/Plin tardan, el comprador paga en el último segundo, el webhook se reintenta).
--  Con la tabla de transiciones original, ese pago era irrecuperable: `expired` no
--  tenía salida, así que el comprador pagaba y el pedido quedaba muerto.
--
--  1. Se agrega la transición ('expired' → 'confirmed').
--  2. `inventory_rereserve_order()` vuelve a retener el stock que el reaper liberó.
--  3. `confirm_order_payment()` hace todo lo anterior de forma atómica y auditable.
--
--  IDEMPOTENTE: se puede re-ejecutar sin efectos secundarios.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
--  1. La transición que faltaba
--     `requires_role` es documental (el trigger sólo valida que el par exista),
--     pero deja escrito quién puede provocarla: sólo el sistema, nunca un humano.
-- -----------------------------------------------------------------------------
INSERT INTO order_status_transitions (from_status, to_status, requires_role, description)
VALUES (
  'expired',
  'confirmed',
  'system',
  'Pago aprobado después de vencida la reserva: se reintenta la reserva de stock'
)
ON CONFLICT (from_status, to_status) DO UPDATE
   SET requires_role = EXCLUDED.requires_role,
       description   = EXCLUDED.description,
       updated_at    = NOW();


-- -----------------------------------------------------------------------------
--  2. Re-reservar el stock de un pedido cuya reserva ya se liberó
--
--  ⚠️  POR QUÉ NO SE PUEDE REUSAR `inventory_reserve_order()`
--  Esa función usa la clave de idempotencia determinista `reserve:<order>:<item>`.
--  Después de la liberación ese movimiento YA EXISTE en el ledger, y
--  `inventory_apply_movement()` devuelve el movimiento existente SIN aplicar el
--  delta (capa 3 anti-duplicado). Resultado: la función "tendría éxito" sin
--  retener una sola unidad y el pedido quedaría confirmado sin stock detrás.
--  Por eso la clave lleva el prefijo `rereserve:`.
--
--  Sólo toca líneas que HOY no están retenidas: el último movimiento de tipo
--  reserva de la línea es una liberación. Si la reserva sigue viva (o la línea ya
--  se vendió) no se hace nada — así es imposible doble-reservar.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION inventory_rereserve_order(
  p_order_id      UUID,
  p_location_code TEXT DEFAULT 'MAIN'
)
RETURNS INTEGER                                             -- líneas re-reservadas
LANGUAGE plpgsql
AS $$
DECLARE
  v_item  RECORD;
  v_count INTEGER := 0;
BEGIN
  FOR v_item IN
    SELECT oi.id, oi.product_slug, oi.variant_key, oi.quantity
      FROM order_items oi
     WHERE oi.order_id = p_order_id
       AND (
             SELECT m.movement_type
               FROM inventory_movements m
              WHERE m.order_item_id = oi.id
                AND m.movement_type IN ('reservation', 'reservation_release', 'sale')
              ORDER BY m.created_at DESC, m.id DESC
              LIMIT 1
           ) = 'reservation_release'
     ORDER BY oi.line_number
  LOOP
    PERFORM inventory_apply_movement(
      p_product_slug    => v_item.product_slug,
      p_variant_key     => v_item.variant_key,
      p_movement_type   => 'reservation',
      p_reserved_delta  => v_item.quantity,
      p_location_code   => p_location_code,
      p_order_id        => p_order_id,
      p_order_item_id   => v_item.id,
      p_reason          => 'late payment re-reservation',
      p_performed_by    => 'system',
      p_idempotency_key => 'rereserve:' || p_order_id::TEXT || ':' || v_item.id::TEXT
    );
    v_count := v_count + 1;
  END LOOP;

  -- Marca explícita: hay una reserva viva otra vez (el reaper ya no aplica porque
  -- el pedido deja de estar en pending_payment, pero el flag debe decir la verdad).
  IF v_count > 0 THEN
    UPDATE orders SET reservation_released = FALSE WHERE id = p_order_id;
  END IF;

  RETURN v_count;
END $$;


-- -----------------------------------------------------------------------------
--  3. Confirmar el pago de un pedido: una sola unidad atómica
--
--  Qué hace, en orden:
--    a. Bloquea la fila del pedido (FOR UPDATE) para que dos webhooks simultáneos
--       no se pisen.
--    b. Valida el monto y la moneda cobrados contra el pedido.
--    c. Re-reserva el stock si el reaper ya lo había liberado.
--    d. Confirma: status='confirmed', payment_status='paid', payment_reference.
--    e. Deja todo el rastro del cobro en `metadata.payment` (auditoría).
--
--  POLÍTICA DE DINERO: si el pago está aprobado, el pedido se confirma AUNQUE la
--  re-reserva falle. El dinero ya entró; revertir la confirmación no lo devuelve,
--  sólo esconde el problema. En ese caso se marca `metadata.payment.stockConflict`
--  para que el equipo reponga o reembolse.
--
--  NO confirma (marca `needsReview` y devuelve el pedido sin cambios de estado) si:
--    · el monto o la moneda no coinciden con el pedido, o
--    · el pedido ya no se puede confirmar (cancelado, reembolsado…).
--  En ambos casos el cobro queda registrado: el problema es visible, no silencioso.
--
--  Es idempotente: un webhook reintentado sobre un pedido ya pagado devuelve el
--  pedido sin volver a tocar stock ni estado.
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
  v_payment_meta   JSONB;
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
  -- `null`, concatenar contra ese escalar envolvería todo en un array y rompería
  -- la auditoría de todos los cobros siguientes.
  v_payment_meta := CASE
                      WHEN jsonb_typeof(v_order.metadata -> 'payment') = 'object'
                      THEN v_order.metadata -> 'payment'
                      ELSE '{}'::jsonb
                    END
                    || COALESCE(p_payment_metadata, '{}'::jsonb)
                    || jsonb_build_object(
                         'lastPaymentId',       p_payment_id,
                         'lastPaymentAmount',   p_paid_amount,
                         'lastPaymentCurrency', p_currency,
                         'lastPaymentAt',       NOW(),
                         'amountMismatch',      NOT v_amounts_match,
                         'needsReview',         NOT v_confirmable AND NOT v_already_paid
                       );

  IF v_confirmable AND v_order.reservation_released THEN
    BEGIN
      v_rereserved := inventory_rereserve_order(v_order.id, p_location_code);
    EXCEPTION WHEN OTHERS THEN
      -- Bloque anidado: el rollback llega hasta acá, así que no queda una reserva
      -- a medias. La confirmación de más abajo SÍ se aplica.
      v_stock_conflict := TRUE;
      v_stock_error    := SQLERRM;
    END;
  END IF;

  IF v_confirmable THEN
    v_payment_meta := v_payment_meta || jsonb_build_object(
      'stockConflict',       v_stock_conflict,
      'stockConflictReason', v_stock_error,
      'rereservedLines',     v_rereserved
    );
  END IF;

  UPDATE orders
     SET payment_reference      = COALESCE(p_payment_id, payment_reference),
         payment_method         = COALESCE(p_payment_method, payment_method),
         payment_status         = CASE WHEN v_confirmable
                                       THEN 'paid'::payment_status ELSE payment_status END,
         -- Dispara `enforce_order_status_transition`: el par ('expired','confirmed')
         -- tiene que existir en order_status_transitions o esto es un error duro.
         status                 = CASE WHEN v_confirmable
                                       THEN 'confirmed'::order_status ELSE status END,
         -- Ya no hay TTL que correr: el stock está retenido por un pedido pagado.
         reservation_expires_at = CASE WHEN v_confirmable
                                       THEN NULL ELSE reservation_expires_at END,
         reservation_released   = CASE WHEN NOT v_confirmable THEN reservation_released
                                       WHEN v_stock_conflict THEN TRUE
                                       ELSE FALSE END,
         metadata               = jsonb_set(
                                    COALESCE(metadata, '{}'::jsonb),
                                    '{payment}',
                                    v_payment_meta,
                                    TRUE
                                  )
   WHERE id = v_order.id
   RETURNING * INTO v_order;

  RETURN v_order;
END $$;

COMMIT;

-- =============================================================================
--  VERIFICACIÓN (opcional, en tu rama de desarrollo)
--
--   SELECT from_status, to_status, requires_role
--     FROM order_status_transitions
--    WHERE from_status = 'expired';
--
--  Ensayo en seco dentro de una transacción que se revierte:
--
--   BEGIN;
--     SELECT (confirm_order_payment('PT-000000', 'test-payment', 'yape',
--                                   0, 'PEN', '{}'::jsonb)).status;
--   ROLLBACK;
-- =============================================================================
