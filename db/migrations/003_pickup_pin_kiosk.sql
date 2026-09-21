-- =============================================================================
--  003 — PIN DE RETIRO DE 6 DÍGITOS + CANJE PARA EL KIOSCO
--
--  QUÉ CAMBIA RESPECTO DE 001
--
--  1. `issue_pickup_code()` pasa de 8 caracteres alfanuméricos (32^8 ≈ 1.1e12) a
--     6 dígitos numéricos (10^6). Es un pedido explícito del negocio: la operaria
--     tipea el PIN que le dicta el cliente en un teclado numérico tipo cajero, y
--     un alfabeto A-Z/0-9 sin ambigüedades es imposible de operar así.
--
--     ⚠️  CONSECUENCIA: el espacio de PINs se achicó 6 órdenes de magnitud. Un PIN
--     de 6 dígitos SIN protección se enumera completo en minutos. Por eso esta
--     migración agrega, en el mismo movimiento, el freno de intentos de abajo.
--     Las dos cosas van juntas: el PIN corto solo es aceptable con el freno.
--
--  2. `pickup_attempts`: registro de cada intento de canje (exitoso o no) con
--     dispositivo e IP. Es el contador del freno Y la auditoría para detectar un
--     ataque en curso.
--
--  3. `redeem_pickup_code_verified()`: frena, canjea y CONSOLIDA EL INVENTARIO.
--
--     ⚠️  BUG QUE CIERRA: `redeem_pickup_code()` de 001 marca el pedido como
--     `picked_up` pero NUNCA llama a `inventory_commit_order()`. El stock quedaba
--     retenido a perpetuidad: la reserva nunca se convertía en salida real, así
--     que `quantity_on_hand` jamás bajaba y el mismo SKU se podía seguir vendiendo
--     contra unidades que ya se fueron en la mano del cliente.
--
--  4. `mark_order_ready_for_pickup()`: confirmado → preparando → listo, y emite el
--     PIN, todo en una transacción. El salto por `preparing` no es decorativo: la
--     máquina de estados NO permite `confirmed → ready_for_pickup`, así que sin ese
--     paso el trigger rechaza el cambio.
--
--  IDEMPOTENTE en su mayor parte (ver la nota del punto 1 sobre códigos viejos).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
--  1. Generador de PIN: 6 dígitos numéricos
--
--  Misma firma que en 001 — `markReadyForPickup()`/`issue_pickup_code()` no cambian.
--  Los ceros a la izquierda son válidos: el PIN es una cadena, no un número.
-- -----------------------------------------------------------------------------
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
  -- 10^6 combinaciones. El freno de `redeem_pickup_code_verified()` es lo que hace
  -- que este espacio sea suficiente para un PIN de un solo uso y vida corta.
  v_alphabet CONSTANT TEXT := '0123456789';
  v_length   CONSTANT INTEGER := 6;
  v_code     TEXT;
  v_row      pickup_codes;
  v_try      INTEGER;
BEGIN
  -- Un único código vigente por pedido: los previos se revocan.
  UPDATE pickup_codes
     SET status = 'revoked', revoked_at = NOW(), revocation_reason = 'reissued'
   WHERE order_id = p_order_id AND status = 'issued';

  FOR v_try IN 1..10 LOOP
    v_code := '';
    FOR i IN 1..v_length LOOP
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::INT, 1);
    END LOOP;

    BEGIN
      INSERT INTO pickup_codes (order_id, code, locker_code, locker_slot, expires_at, max_attempts)
      VALUES (p_order_id, v_code, p_locker_code, p_locker_slot, NOW() + p_ttl, p_max_attempts)
      RETURNING * INTO v_row;

      RETURN v_row;
    EXCEPTION WHEN unique_violation THEN
      -- Colisión de código: reintenta con otro.
      CONTINUE;
    END;
  END LOOP;

  RAISE EXCEPTION 'pickup_code_generation_failed' USING ERRCODE = 'P0003';
END $$;

-- Los códigos de 8 caracteres emitidos con el formato viejo no se pueden tipear en
-- el teclado numérico: se revocan. Si había pedidos reales listos, operación debe
-- volver a marcarlos como listos (eso emite un PIN nuevo de 6 dígitos).
-- Es una migración de formato: se corre una vez y no vuelve a tocar nada.
UPDATE pickup_codes
   SET status = 'revoked', revoked_at = NOW(), revocation_reason = 'format_migration_6_digits'
 WHERE status = 'issued'
   AND code !~ '^[0-9]{6}$';


-- -----------------------------------------------------------------------------
--  2. Registro de intentos (freno + auditoría)
--
--  Se guarda el código que se intentó junto con quién lo intentó para poder ver un
--  ataque en curso: "el mismo dispositivo probó 40 códigos en 3 minutos".
--  Volumen esperado: una fila por retiro. Trivial.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pickup_attempts (
  id           BIGSERIAL PRIMARY KEY,
  code_attempt TEXT NOT NULL,                 -- el PIN tal como llegó (normalizado)
  -- 'ok' | pickup_code_not_found | pickup_code_expired | pickup_code_locked |
  -- pickup_code_already_used | throttled
  outcome      TEXT NOT NULL,
  device_id    TEXT,
  ip           TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pickup_attempts_window
  ON pickup_attempts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pickup_attempts_device
  ON pickup_attempts (device_id, created_at DESC);


-- -----------------------------------------------------------------------------
--  3. Canje para el kiosco: freno + canje + entrega definitiva de stock
--
--  Orden de las operaciones (importa):
--    a. Freno por ventana de intentos. Se evalúa ANTES de mirar el PIN, así que un
--       ataque no consume trabajo de base ni puede "adivinar por timing".
--    b. `redeem_pickup_code()` — el canje de un solo uso que ya existía.
--    c. `inventory_commit_order()` — la reserva se convierte en salida real.
--
--  Todo en una transacción: si (c) falla, (b) se revierte y el PIN sigue sirviendo.
--  Nunca queda un PIN consumido con el stock todavía retenido.
--
--  LÍMITES DEL FRENO: la ventana es por dispositivo/IP y global. Un atacante que
--  rote muchas IPs esquiva el límite por dispositivo, y por eso está el global
--  (90 fallos / 10 min en total). Ninguno de los dos detiene a un atacante
--  infinitamente pacientes: lo que hacen es volver el ataque ruidoso, lento e
--  inviable mientras haya un pedido esperando, y dejar el rastro en `pickup_attempts`.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION redeem_pickup_code_verified(
  p_code        TEXT,
  p_redeemed_by TEXT DEFAULT NULL,             -- operaria / terminal: 'kiosk:suzuki-03'
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
  committed_lines INTEGER                     -- líneas que salieron de inventario
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_window       CONSTANT INTERVAL := INTERVAL '10 minutes';
  -- Holgado para una persona que se equivoca al tipear; letal para un script.
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

  -- La entrega física consolida la reserva. Si acá falta stock (la reserva ya no
  -- estaba), esto lanza `insufficient_stock` y se revierte TODO: mejor un PIN que
  -- sigue sirviendo y una operaria confundida que un inventario mentiroso.
  v_committed := inventory_commit_order(v_redeem.order_id, 'picked_up');

  RETURN QUERY
    SELECT TRUE, NULL::TEXT, v_redeem.pickup_code_id, v_redeem.order_id,
           v_redeem.order_number, v_redeem.locker_code, v_redeem.locker_slot, v_committed;
END $$;


-- -----------------------------------------------------------------------------
--  4. Marcar un pedido como listo (y emitir el PIN)
--
--  Reemplaza al `markReadyForPickup()` que hacía un solo UPDATE y por eso fallaba
--  con `invalid_order_transition` en pedidos recién confirmados: la máquina de
--  estados exige pasar por `preparing`.
--
--  Los dos guardas existen para que la operaria no pueda entregar algo que no
--  corresponde: sólo pedidos PAGADOS y en un estado previo al retiro.
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

  -- Sin pago confirmado no se entrega mercadería. Es la única barrera que impide
  -- que un PIN se emita para un pedido impago si algún día se agrega otro camino
  -- a `ready_for_pickup`.
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

COMMIT;

-- =============================================================================
--  VERIFICACIÓN (opcional, en tu rama de desarrollo)
--
--   -- El PIN ahora es de 6 dígitos:
--   SELECT order_number, status,
--          (SELECT code FROM pickup_codes c WHERE c.order_id = o.id AND c.status = 'issued') AS pin
--     FROM orders o WHERE status = 'ready_for_pickup';
--
--   -- Freno funcionando (los 15 primeros devuelven not_found, el 16 rate_limited):
--   SELECT error_code FROM redeem_pickup_code_verified('000000', 'test', 'dev-1', '127.0.0.1')
--    FROM generate_series(1, 16);
--   -- (Limpia después: DELETE FROM pickup_attempts WHERE device_id = 'dev-1';)
-- =============================================================================
