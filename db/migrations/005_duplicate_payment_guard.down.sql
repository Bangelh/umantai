-- Reversa de 005_duplicate_payment_guard.sql.
--
-- OJO (LEER ANTES DE USAR): esto RESTAURA la definición de `confirm_order_payment`
-- de la migración 002, es decir, VUELVE A INTRODUCIR el bug de doble pago
-- (sobrescribe `payment_reference`/`payment_method` con un segundo pago y no marca
-- revisión). No hay pérdida de datos: solo revierte el comportamiento de la
-- función. Úsalo únicamente si necesitas volver atrás el cambio de código por un
-- problema mayor; en operación normal, no lo ejecutes.
--
-- Los datos ya escritos en `metadata.payment.receivedPayments`/`duplicatePayment`
-- NO se borran (son aditivos e informativos).

BEGIN;

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
         status                 = CASE WHEN v_confirmable
                                       THEN 'confirmed'::order_status ELSE status END,
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

COMMENT ON FUNCTION confirm_order_payment(TEXT, TEXT, TEXT, NUMERIC, TEXT, JSONB, TEXT, TEXT) IS
  'Confirma el pago de un pedido (definición previa a 005).';

COMMIT;
