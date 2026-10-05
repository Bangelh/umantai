-- Reversa de 006_fulfillment_stock_conflict_guard.sql.
--
-- OJO (LEER ANTES DE USAR): esto RESTAURA las definiciones previas y por lo tanto
-- VUELVE A INTRODUCIR el bug: `confirm_order_payment` CASO A dejará `needsReview`
-- en FALSE ante un conflicto de stock, y se eliminan las guardas de fulfillment.
-- No hay pérdida de datos: solo revierte el comportamiento de las funciones.
-- El backfill de `needsReview=true` NO se revierte (es correctivo e informativo).
--
-- Restaura:
--   · confirm_order_payment          → definición de 005 (needsReview FALSE fijo)
--   · mark_order_ready_for_pickup    → definición de 003 (sin guarda)
--   · inventory_commit_order         → definición de 001 (sin guarda)
--   · redeem_pickup_code_verified    → definición de 003 (sin protección)

BEGIN;

-- -----------------------------------------------------------------------------
--  confirm_order_payment — versión 005
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION confirm_order_payment(
  p_order_number     TEXT,
  p_payment_id       TEXT,
  p_payment_method   TEXT     DEFAULT NULL,
  p_paid_amount      NUMERIC  DEFAULT NULL,
  p_currency         TEXT     DEFAULT NULL,
  p_payment_metadata JSONB    DEFAULT '{}'::jsonb,
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
  v_incoming       JSONB;
  v_received       JSONB;
  v_primary_id     TEXT;
  v_primary_entry  JSONB;
  v_is_known_dup   BOOLEAN;
BEGIN
  SELECT * INTO v_order
    FROM orders
   WHERE order_number = p_order_number
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  PERFORM set_config('app.actor', COALESCE(NULLIF(p_actor, ''), 'mercadopago:webhook'), TRUE);

  v_amounts_match := (p_paid_amount IS NULL OR p_paid_amount = v_order.total)
                     AND (p_currency IS NULL OR upper(p_currency) = upper(v_order.currency));
  v_already_paid  := v_order.payment_status = 'paid';
  v_confirmable   := NOT v_already_paid
                     AND v_order.status IN ('pending_payment', 'expired')
                     AND v_amounts_match;

  v_payment_meta := CASE
                      WHEN jsonb_typeof(v_order.metadata -> 'payment') = 'object'
                      THEN v_order.metadata -> 'payment'
                      ELSE '{}'::jsonb
                    END;

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

  IF v_already_paid THEN
    v_primary_id := COALESCE(
      NULLIF(v_order.payment_reference, ''),
      v_payment_meta -> 'receivedPayments' -> 0 ->> 'id'
    );

    IF p_payment_id IS NOT NULL AND p_payment_id = v_primary_id THEN
      RETURN v_order;
    END IF;
  END IF;

  IF v_confirmable THEN
    v_received := jsonb_build_array(v_incoming || jsonb_build_object('primary', TRUE));

    IF v_order.reservation_released THEN
      BEGIN
        v_rereserved := inventory_rereserve_order(v_order.id, p_location_code);
      EXCEPTION WHEN OTHERS THEN
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
  'Confirma el pago de un pedido (definición previa a 006: needsReview=FALSE en CASO A).';


-- -----------------------------------------------------------------------------
--  mark_order_ready_for_pickup — versión 003 (sin guarda)
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
--  inventory_commit_order — versión 001 (sin guarda)
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
--  redeem_pickup_code_verified — versión 003 (sin protección)
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

  v_committed := inventory_commit_order(v_redeem.order_id, 'picked_up');

  RETURN QUERY
    SELECT TRUE, NULL::TEXT, v_redeem.pickup_code_id, v_redeem.order_id,
           v_redeem.order_number, v_redeem.locker_code, v_redeem.locker_slot, v_committed;
END $$;

COMMIT;
