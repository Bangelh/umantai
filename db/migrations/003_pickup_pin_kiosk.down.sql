-- Reversa de 003_pickup_pin_kiosk.sql.
--
-- OJO: al restaurar el generador de 8 caracteres, los PIN de 6 dígitos ya emitidos
-- siguen siendo válidos para `redeem_pickup_code()` (que no valida formato), pero
-- los clientes que los tengan en mano quedan con un código que el kiosco ya no
-- puede tipear. Revócalos antes de bajar si hay pedidos reales esperando retiro:
--
--   UPDATE pickup_codes SET status = 'revoked', revoked_at = NOW(),
--          revocation_reason = 'rollback_003'
--    WHERE status = 'issued';

BEGIN;

DROP FUNCTION IF EXISTS redeem_pickup_code_verified(TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS mark_order_ready_for_pickup(UUID, TEXT, TEXT, INTERVAL, INTEGER, TEXT);
DROP TABLE IF EXISTS pickup_attempts;

-- Restaura el generador alfanumérico de 8 caracteres de la migración 001.
-- Este paso NO se puede revertir solo: pierde el formato nuevo, pero los PIN ya
-- emitidos no se regeneran. Es exactamente lo que se espera de una reversa.
CREATE OR REPLACE FUNCTION issue_pickup_code(
  p_order_id     UUID,
  p_locker_code  TEXT DEFAULT NULL,
  p_locker_slot  TEXT DEFAULT NULL,
  p_ttl          INTERVAL DEFAULT INTERVAL '7 days',
  p_max_attempts INTEGER DEFAULT 5
)
RETURNS pickup_codes
LANGUAGE plpgsql
AS $$
DECLARE
  v_alphabet CONSTANT TEXT := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  v_code     TEXT;
  v_row      pickup_codes;
  v_try      INTEGER;
BEGIN
  UPDATE pickup_codes
     SET status = 'revoked', revoked_at = NOW(), revocation_reason = 'reissued'
   WHERE order_id = p_order_id AND status = 'issued';

  FOR v_try IN 1..10 LOOP
    v_code := '';
    FOR i IN 1..8 LOOP
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::INT, 1);
    END LOOP;

    BEGIN
      INSERT INTO pickup_codes (order_id, code, locker_code, locker_slot, expires_at, max_attempts)
      VALUES (p_order_id, v_code, p_locker_code, p_locker_slot, NOW() + p_ttl, p_max_attempts)
      RETURNING * INTO v_row;

      RETURN v_row;
    EXCEPTION WHEN unique_violation THEN
      CONTINUE;
    END;
  END LOOP;

  RAISE EXCEPTION 'pickup_code_generation_failed' USING ERRCODE = 'P0003';
END $$;

COMMIT;

-- Después de bajar esta migración, la capa de datos vuelve a necesitar
-- `markReadyForPickup()`/`redeemPickupCode()` apuntando a las funciones de 001
-- (el código de `lib/commerce.server.ts` que usa las funciones nuevas fallará).
