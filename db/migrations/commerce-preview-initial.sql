-- =============================================================================
--  commerce-preview-initial.sql  —  ESQUEMA CUSTOM DE COMMERCE (PREVIEW)
--
--  Concatenación FIEL, en orden, de los bloques up() de:
--    001_commerce_core.sql
--    002_payment_confirmation.sql
--    003_pickup_pin_kiosk.sql
--
--  Generado automáticamente. NO editar a mano: regenerar desde 001/002/003.
--  Los .down.sql correspondientes NO están incluidos (no se borra nada acá).
--  Convive con el schema Payload ya aplicado (18 tablas). Sin colisiones.
--  PREPARADO, NO EJECUTADO todavía contra Neon.
-- =============================================================================

-- >>>>>>>>>> BEGIN db/migrations/001_commerce_core.sql <<<<<<<<<<
-- =============================================================================
--  Umantai · Motor transaccional — Fase 1 (MVP)
--  Archivo: db/migrations/001_commerce_core.sql
--  Motor:   PostgreSQL 15+  (Neon / Supabase Postgres)
--
--  QUÉ CREA
--    · customers                  compradores (registrados o invitados)
--    · orders                     cabecera del pedido + máquina de estados
--    · order_items                líneas con snapshot de precio/nombre
--    · inventory                  existencias por SKU + local, con disponible generado
--    · inventory_movements        ledger APPEND-ONLY de todo movimiento de stock
--    · pickup_codes               códigos de retiro del módulo Locker
--    · order_status_transitions   matriz de transiciones válidas (data, no código)
--    · order_status_history       auditoría de cada cambio de estado
--
--  ANTI-SOBREVENTA (3 capas independientes, no una sola)
--    1) CHECK (quantity_reserved <= quantity_on_hand)
--       El estado "vendido de más" es irrepresentable en la base de datos.
--    2) UPDATE condicional atómico dentro de inventory_apply_movement()
--       Nadie reserva la última unidad dos veces: el row lock serializa a los
--       competidores y el WHERE filtra por disponibilidad real.
--    3) Ledger idempotente (idempotency_key UNIQUE)
--       Un reintento del checkout no duplica movimientos ni descuenta dos veces.
--
--  CÓMO EJECUTARLO
--    psql "$POSTGRES_URL_NON_POOLING" -f db/migrations/001_commerce_core.sql
--    o pegar el contenido completo en el SQL Editor de Neon / Supabase.
--    El script es idempotente: se puede re-ejecutar sin destruir datos.
--
--  ROLLBACK
--    db/migrations/001_commerce_core.down.sql
--
--  NOTA DE ARQUITECTURA
--    Estas tablas viven en el schema `public` junto a las de Payload CMS.
--    Si algún día se crea una colección de Payload con slug `orders`, `customers`,
--    `inventory` o `pickup-codes`, Payload intentará crear una tabla con el mismo
--    nombre y chocará (ya ocurre hoy con `product_overrides`). En ese caso: mover
--    este motor a un schema dedicado (`commerce`) o renombrar la colección.
-- =============================================================================

BEGIN;

-- =============================================================================
--  0. TIPOS ENUMERADOS
-- =============================================================================

-- Estados del pedido. El orden de declaración es solo legibilidad:
-- la validez de las transiciones vive en order_status_transitions.
DO $$
BEGIN
  CREATE TYPE order_status AS ENUM (
    'pending_payment',   -- creado, esperando pago / confirmación (retiene stock)
    'confirmed',         -- pago confirmado
    'preparing',         -- el operador está armando el pedido
    'ready_for_pickup',  -- listo: se emite código de Locker
    'picked_up',         -- retirado por el cliente
    'out_for_delivery',  -- en ruta
    'delivered',         -- entregado a domicilio
    'completed',         -- ciclo cerrado (fin contable)
    'cancelled',         -- cancelado por cliente/operador (terminal)
    'expired',           -- reserva vencida sin pago (terminal)
    'refunded'           -- devuelto (terminal)
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE order_channel AS ENUM ('web', 'kiosk', 'admin', 'whatsapp');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE fulfillment_type AS ENUM ('pickup_locker', 'pickup_counter', 'delivery');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE payment_status AS ENUM ('pending', 'authorized', 'paid', 'failed', 'partially_refunded', 'refunded');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE inventory_movement_type AS ENUM (
    'receipt',             -- ingreso de mercadería        (+on_hand)
    'reservation',         -- retención por pedido         (+reserved)
    'reservation_release', -- liberación (cancelación/expiración) (-reserved)
    'sale',                -- reserva consumida: sale del stock (-on_hand, -reserved)
    'adjustment',          -- corrección manual auditada
    'recount',             -- inventario físico
    'return',              -- devolución de cliente       (+on_hand)
    'shrinkage',           -- merma / robo                 (-on_hand)
    'transfer_in',
    'transfer_out'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE pickup_code_status AS ENUM ('issued', 'redeemed', 'expired', 'revoked');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- =============================================================================
--  1. CUSTOMERS
--     Comprador. `auth_user_id` enlaza con Supabase Auth cuando el cliente
--     tiene sesión; los pedidos como invitado quedan con customer_id NULL.
-- =============================================================================

CREATE TABLE IF NOT EXISTS customers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL,
  phone           TEXT,
  full_name       TEXT NOT NULL,
  doc_type        TEXT,                       -- 'DNI' | 'RUC' | 'CE' ...
  doc_number      TEXT,
  auth_user_id    UUID,                       -- auth.users.id de Supabase (opcional)
  default_address JSONB,                      -- snapshot de dirección de entrega
  marketing_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
  total_orders    INTEGER NOT NULL DEFAULT 0 CHECK (total_orders >= 0),
  total_spent     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total_spent >= 0),
  notes           TEXT,                       -- notas internas de operación
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ                 -- soft delete (nunca borrar historial)
);

-- Un email no puede repetirse entre clientes vivos (case-insensitive).
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_email_alive
  ON customers (lower(email))
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_auth_user
  ON customers (auth_user_id)
  WHERE auth_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers (phone);

-- =============================================================================
--  2. ORDERS
-- =============================================================================

-- Correlativo humano legible: UM-2026-001001
CREATE SEQUENCE IF NOT EXISTS order_number_seq START 1001;

CREATE TABLE IF NOT EXISTS orders (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number         TEXT NOT NULL
                       DEFAULT 'UM-' || to_char(NOW(), 'YYYY') || '-'
                             || lpad(nextval('order_number_seq')::TEXT, 6, '0'),
  public_token         UUID NOT NULL DEFAULT gen_random_uuid(),  -- link público guest: /pedido/<token>
  idempotency_key      TEXT,                                     -- evita doble submit del checkout

  customer_id          UUID REFERENCES customers(id) ON DELETE SET NULL,
  contact_email        TEXT NOT NULL,
  contact_phone        TEXT,

  channel              order_channel NOT NULL DEFAULT 'web',
  fulfillment_type     fulfillment_type NOT NULL,
  locker_code          TEXT,                                     -- local/locker elegido (si aplica)

  status               order_status NOT NULL DEFAULT 'pending_payment',
  payment_status       payment_status NOT NULL DEFAULT 'pending',
  payment_method       TEXT,
  payment_reference    TEXT,                                     -- id del PSP / Nº de operación
  currency             TEXT NOT NULL DEFAULT 'PEN'
                       CHECK (currency ~ '^[A-Z]{3}$'),

  -- Montos en NUMERIC (nunca float para dinero). El CHECK garantiza cuadratura.
  subtotal             NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  discount_total       NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (discount_total >= 0),
  tax_total            NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
  shipping_total       NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (shipping_total >= 0),
  total                NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  item_count           INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),

  shipping_address     JSONB,
  pickup_instructions  TEXT,
  customer_note        TEXT,

  -- TTL de la reserva de stock para pedidos sin pagar (barrido por expire_stale_orders()).
  reservation_expires_at TIMESTAMPTZ,
  reservation_released   BOOLEAN NOT NULL DEFAULT FALSE,

  -- Sellos de tiempo por hito. Los escribe el trigger, no la aplicación.
  confirmed_at         TIMESTAMPTZ,
  ready_at             TIMESTAMPTZ,
  picked_up_at         TIMESTAMPTZ,
  delivered_at         TIMESTAMPTZ,
  cancelled_at         TIMESTAMPTZ,
  cancelled_reason     TEXT,

  metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,
  version              INTEGER NOT NULL DEFAULT 0,   -- optimistic locking

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT orders_total_balanced_chk
    CHECK (total = subtotal - discount_total + tax_total + shipping_total),
  CONSTRAINT orders_pickup_expiry_chk
    CHECK (reservation_expires_at IS NULL OR reservation_expires_at > created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_number ON orders (order_number);
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_public_token ON orders (public_token);
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_idempotency
  ON orders (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_customer     ON orders (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status       ON orders (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_created      ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_contact      ON orders (lower(contact_email));
-- Índice para el reaper de reservas vencidas:
CREATE INDEX IF NOT EXISTS idx_orders_expiring
  ON orders (reservation_expires_at)
  WHERE status = 'pending_payment' AND reservation_released = FALSE;

-- =============================================================================
--  3. ORDER_ITEMS
--     Snapshot inmutable: el precio y el nombre se copian al momento de comprar.
--     Nunca se hace JOIN contra `products` para mostrar un pedido histórico.
-- =============================================================================

CREATE TABLE IF NOT EXISTS order_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  line_number     INTEGER NOT NULL CHECK (line_number > 0),

  product_slug    TEXT NOT NULL,          -- clave estable del producto (la misma del frontend/Payload)
  product_name    TEXT NOT NULL,
  product_brand   TEXT,
  image_url       TEXT,
  variant_key     TEXT NOT NULL DEFAULT '',  -- SKU físico: 'color:negro|storage:256'
  variant         JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {color, storage, ...} legible

  quantity        INTEGER NOT NULL CHECK (quantity > 0),
  unit_price      NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
  discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  tax_amount      NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  line_total      NUMERIC(12,2) NOT NULL CHECK (line_total >= 0),

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT order_items_unique_line UNIQUE (order_id, line_number),
  CONSTRAINT order_items_line_total_chk
    CHECK (line_total = round(quantity * unit_price - discount_amount + tax_amount, 2))
);

CREATE INDEX IF NOT EXISTS idx_order_items_order   ON order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items (product_slug);

-- =============================================================================
--  4. INVENTORY
--     Fuente de verdad del stock. `quantity_available` es una columna GENERADA:
--     no se puede desincronizar porque no se escribe, se deriva.
-- =============================================================================

CREATE TABLE IF NOT EXISTS inventory (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_code      TEXT NOT NULL DEFAULT 'MAIN',   -- local/locker (futuro FK a `locations`)
  product_slug       TEXT NOT NULL,
  variant_key        TEXT NOT NULL DEFAULT '',

  quantity_on_hand   INTEGER NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
  quantity_reserved  INTEGER NOT NULL DEFAULT 0 CHECK (quantity_reserved >= 0),

  reorder_point      INTEGER NOT NULL DEFAULT 0 CHECK (reorder_point >= 0),
  restock_eta        DATE,
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Capa 1 anti-sobreventa: lo reservado jamás puede superar lo que hay físicamente.
  CONSTRAINT inventory_no_oversell_chk CHECK (quantity_reserved <= quantity_on_hand),
  CONSTRAINT inventory_sku_unique UNIQUE (location_code, product_slug, variant_key),

  quantity_available INTEGER GENERATED ALWAYS AS (quantity_on_hand - quantity_reserved) STORED
);

CREATE INDEX IF NOT EXISTS idx_inventory_product ON inventory (product_slug, variant_key);
CREATE INDEX IF NOT EXISTS idx_inventory_active_location
  ON inventory (location_code)
  WHERE is_active = TRUE;

-- =============================================================================
--  5. INVENTORY_MOVEMENTS  (ledger append-only)
--     Cada fila explica "por qué" cambió el stock y guarda el saldo resultante,
--     así la auditoría no depende de recalcular sumas históricas.
-- =============================================================================

CREATE TABLE IF NOT EXISTS inventory_movements (
  id              BIGSERIAL PRIMARY KEY,           -- alto volumen: sequence barata
  -- RESTRICT (no CASCADE/SET NULL): el histórico contable nunca se reescribe,
  -- ni siquiera indirectamente al borrar un pedido.
  inventory_id    UUID NOT NULL REFERENCES inventory(id) ON DELETE RESTRICT,
  order_id        UUID REFERENCES orders(id) ON DELETE RESTRICT,
  order_item_id   UUID REFERENCES order_items(id) ON DELETE RESTRICT,

  movement_type   inventory_movement_type NOT NULL,
  on_hand_delta   INTEGER NOT NULL DEFAULT 0,
  reserved_delta  INTEGER NOT NULL DEFAULT 0,
  on_hand_after   INTEGER NOT NULL,
  reserved_after  INTEGER NOT NULL,

  reason          TEXT,
  performed_by    TEXT,                            -- 'system', 'admin:jane', 'kiosk:03'
  idempotency_key TEXT,                            -- capa 3 anti-sobreventa / anti-duplicado

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT inventory_movements_delta_chk
    CHECK (on_hand_delta <> 0 OR reserved_delta <> 0),
  CONSTRAINT inventory_movements_balance_chk
    CHECK (on_hand_after >= 0 AND reserved_after >= 0 AND reserved_after <= on_hand_after)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_movements_idempotency
  ON inventory_movements (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_movements_inventory
  ON inventory_movements (inventory_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_order
  ON inventory_movements (order_id, created_at DESC);

-- =============================================================================
--  6. PICKUP_CODES  (módulo Locker)
--     Código corto de un solo uso. Se guarda en claro porque el cliente debe
--     poder verlo; la seguridad viene de TTL + intentos + consumo atómico.
-- =============================================================================

CREATE TABLE IF NOT EXISTS pickup_codes (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  code               TEXT NOT NULL,
  locker_code        TEXT,                        -- local donde está el locker
  locker_slot        TEXT,                        -- compartimento físico ('A-12')
  status             pickup_code_status NOT NULL DEFAULT 'issued',
  max_attempts       INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  attempts           INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at         TIMESTAMPTZ NOT NULL,
  redeemed_at        TIMESTAMPTZ,
  redeemed_by        TEXT,                         -- kiosco / operador que validó
  revoked_at         TIMESTAMPTZ,
  revocation_reason  TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pickup_codes_format_chk CHECK (code ~ '^[0-9A-Z]{6,12}$'),
  CONSTRAINT pickup_codes_redeemed_chk CHECK (
    (status = 'redeemed' AND redeemed_at IS NOT NULL) OR
    (status <> 'redeemed')
  )
);

-- Los códigos son GLOBALMENTE únicos y no se reciclan jamás: si un código viejo
-- pudiera reasignarse, un papel impreso con ese código apuntaría a otro pedido.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pickup_codes_code
  ON pickup_codes (code);

-- Un único código vigente por pedido.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pickup_codes_one_issued_per_order
  ON pickup_codes (order_id)
  WHERE status = 'issued';

CREATE INDEX IF NOT EXISTS idx_pickup_codes_order ON pickup_codes (order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pickup_codes_expiring
  ON pickup_codes (expires_at)
  WHERE status = 'issued';

-- =============================================================================
--  7. MÁQUINA DE ESTADOS DE ORDERS
--     Las transiciones válidas son DATOS, no código: se pueden ajustar sin
--     deploy y el trigger las aplica a cualquier escritura (API, admin, script).
-- =============================================================================

CREATE TABLE IF NOT EXISTS order_status_transitions (
  from_status order_status NOT NULL,
  to_status   order_status NOT NULL,
  requires_role TEXT,                                  -- p.ej. 'admin' para refunds
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (from_status, to_status),
  CONSTRAINT order_status_transitions_no_self CHECK (from_status <> to_status)
);

INSERT INTO order_status_transitions (from_status, to_status, requires_role, description) VALUES
  ('pending_payment', 'confirmed',        NULL,    'Pago confirmado por el PSP'),
  ('pending_payment', 'cancelled',        NULL,    'Cancelado antes de pagar'),
  ('pending_payment', 'expired',          'system','Reserva de stock vencida sin pago'),
  ('confirmed',       'preparing',        NULL,    'Operación empieza a armar el pedido'),
  ('confirmed',       'cancelled',        'admin', 'Cancelado con reembolso posterior'),
  ('confirmed',       'refunded',         'admin', 'Anulado y devuelto'),
  ('preparing',       'ready_for_pickup', NULL,    'Listo para retiro'),
  ('preparing',       'out_for_delivery', NULL,    'Despachado a delivery'),
  ('preparing',       'cancelled',        'admin', 'Cancelado durante preparación'),
  ('ready_for_pickup','picked_up',        NULL,    'Código de Locker canjeado'),
  ('ready_for_pickup','cancelled',        'admin', 'No retirado / cancelado'),
  ('out_for_delivery','delivered',        NULL,    'Entregado en destino'),
  ('out_for_delivery','cancelled',        'admin', 'Entrega fallida'),
  ('picked_up',       'completed',        NULL,    'Ciclo cerrado'),
  ('picked_up',       'refunded',         'admin', 'Devolución post-retiro'),
  ('delivered',       'completed',        NULL,    'Ciclo cerrado'),
  ('delivered',       'refunded',         'admin', 'Devolución post-entrega'),
  ('completed',       'refunded',         'admin', 'Reembolso tardío')
ON CONFLICT (from_status, to_status) DO NOTHING;

CREATE TABLE IF NOT EXISTS order_status_history (
  id          BIGSERIAL PRIMARY KEY,
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status order_status,
  to_status   order_status NOT NULL,
  changed_by  TEXT,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_status_history_order
  ON order_status_history (order_id, created_at DESC);

-- =============================================================================
--  8. FUNCIONES Y TRIGGERS
-- =============================================================================

-- 8.1 updated_at automático -------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END $$;

-- 8.2 Guardián de la máquina de estados -------------------------------------
-- Valida contra order_status_transitions, sella hitos y escribe la auditoría.
-- `SET LOCAL app.actor = 'admin:jane'` en la transacción para registrar quién.
CREATE OR REPLACE FUNCTION enforce_order_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_allowed BOOLEAN;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN

    SELECT EXISTS (
      SELECT 1 FROM order_status_transitions t
       WHERE t.from_status = OLD.status
         AND t.to_status   = NEW.status
    ) INTO v_allowed;

    IF NOT v_allowed THEN
      RAISE EXCEPTION 'invalid_order_transition: % -> %', OLD.status, NEW.status
        USING ERRCODE = '23514',
              HINT    = 'Consulta order_status_transitions para ver las transiciones permitidas.';
    END IF;

    -- Hitos: los escribe la base, el cliente no los puede falsificar.
    NEW.confirmed_at := CASE WHEN NEW.status = 'confirmed'
                             THEN COALESCE(NEW.confirmed_at, NOW()) ELSE NEW.confirmed_at END;
    NEW.ready_at     := CASE WHEN NEW.status = 'ready_for_pickup'
                             THEN COALESCE(NEW.ready_at, NOW())     ELSE NEW.ready_at END;
    NEW.picked_up_at := CASE WHEN NEW.status = 'picked_up'
                             THEN COALESCE(NEW.picked_up_at, NOW()) ELSE NEW.picked_up_at END;
    NEW.delivered_at := CASE WHEN NEW.status = 'delivered'
                             THEN COALESCE(NEW.delivered_at, NOW()) ELSE NEW.delivered_at END;
    NEW.cancelled_at := CASE WHEN NEW.status IN ('cancelled', 'expired')
                             THEN COALESCE(NEW.cancelled_at, NOW()) ELSE NEW.cancelled_at END;
    NEW.version      := COALESCE(OLD.version, 0) + 1;

    INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, reason)
    VALUES (NEW.id, OLD.status, NEW.status,
            current_setting('app.actor', TRUE),
            NEW.cancelled_reason);
  END IF;

  RETURN NEW;
END $$;

-- 8.3 Recálculo de totales desde las líneas ---------------------------------
-- Reconstruye cabecera a partir de order_items respetando el CHECK de cuadratura
-- (shipping_total debe estar fijado antes de llamarla).
-- Para correcciones administrativas: SET LOCAL app.allow_line_edits = 'on' primero
-- si el pedido ya no está en pending_payment.
CREATE OR REPLACE FUNCTION refresh_order_totals_from_items(p_order_id UUID)
RETURNS orders
LANGUAGE plpgsql
AS $$
DECLARE
  v_order orders;
BEGIN
  UPDATE orders o
     SET item_count     = COALESCE(agg.qty, 0),
         subtotal       = COALESCE(agg.subtotal, 0),
         discount_total = COALESCE(agg.discount, 0),
         tax_total      = COALESCE(agg.tax, 0),
         total          = COALESCE(agg.subtotal, 0) - COALESCE(agg.discount, 0)
                          + COALESCE(agg.tax, 0) + o.shipping_total
    FROM (
      SELECT SUM(quantity)             AS qty,
             SUM(quantity * unit_price) AS subtotal,
             SUM(discount_amount)       AS discount,
             SUM(tax_amount)            AS tax
        FROM order_items
       WHERE order_id = p_order_id
    ) agg
   WHERE o.id = p_order_id
  RETURNING o.* INTO v_order;

  RETURN v_order;
END $$;

-- 8.4 Ledger append-only ----------------------------------------------------
CREATE OR REPLACE FUNCTION prevent_ledger_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'inventory_movements es append-only: % no permitido', TG_OP
    USING ERRCODE = '42501',
          HINT    = 'Registra un movimiento contrario (p.ej. adjustment) en lugar de editar el histórico.';
END $$;

-- 8.5 Líneas bloqueadas tras confirmar el pedido ----------------------------
CREATE OR REPLACE FUNCTION guard_order_items_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_order_id UUID;
  v_status   order_status;
BEGIN
  -- Escape hatch explícito para correcciones administrativas auditadas:
  IF current_setting('app.allow_line_edits', TRUE) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_order_id := COALESCE(NEW.order_id, OLD.order_id);

  SELECT status INTO v_status FROM orders WHERE id = v_order_id;

  IF v_status IS NOT NULL AND v_status <> 'pending_payment' THEN
    RAISE EXCEPTION 'order_items_locked: el pedido está en % y sus líneas son inmutables', v_status
      USING ERRCODE = '55006',
            HINT    = 'SET LOCAL app.allow_line_edits = ''on'' para forzar el cambio desde un script administrativo.';
  END IF;

  RETURN COALESCE(NEW, OLD);
END $$;

-- 8.6 PRIMITIVA ANTI-SOBREVENTA --------------------------------------------
-- Único camino sancionado para tocar el stock. Atómico y con bloqueo de fila.
-- Devuelve la fila del ledger (o la existente si la idempotency_key ya se aplicó).
CREATE OR REPLACE FUNCTION inventory_apply_movement(
  p_product_slug     TEXT,
  p_variant_key      TEXT DEFAULT '',
  p_movement_type    inventory_movement_type DEFAULT 'adjustment',
  p_on_hand_delta    INTEGER DEFAULT 0,
  p_reserved_delta   INTEGER DEFAULT 0,
  p_location_code    TEXT DEFAULT 'MAIN',
  p_order_id         UUID DEFAULT NULL,
  p_order_item_id    UUID DEFAULT NULL,
  p_reason           TEXT DEFAULT NULL,
  p_performed_by     TEXT DEFAULT NULL,          -- NULL => current_user
  p_idempotency_key  TEXT DEFAULT NULL
)
RETURNS inventory_movements
LANGUAGE plpgsql
AS $$
DECLARE
  v_inventory inventory;
  v_movement  inventory_movements;
  v_existing  inventory_movements;
BEGIN
  IF p_on_hand_delta = 0 AND p_reserved_delta = 0 THEN
    RAISE EXCEPTION 'inventory_apply_movement: se requiere al menos un delta distinto de cero'
      USING ERRCODE = '22023';
  END IF;

  -- Idempotencia (capa 3): un reintento devuelve el mismo movimiento, no lo duplica.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing
      FROM inventory_movements
     WHERE idempotency_key = p_idempotency_key;

    IF FOUND THEN
      RETURN v_existing;
    END IF;
  END IF;

  -- El SKU puede no existir todavía (producto nuevo): se crea en cero.
  INSERT INTO inventory (location_code, product_slug, variant_key, quantity_on_hand, quantity_reserved)
  VALUES (COALESCE(p_location_code, 'MAIN'), p_product_slug, COALESCE(p_variant_key, ''), 0, 0)
  ON CONFLICT (location_code, product_slug, variant_key) DO NOTHING;

  -- Capa 2: una sola sentencia. El row lock serializa a los checkouts concurrentes
  -- y el WHERE exige que, DESPUÉS del cambio, quede disponible >= 0.
  UPDATE inventory
     SET quantity_on_hand  = quantity_on_hand  + p_on_hand_delta,
         quantity_reserved = quantity_reserved + p_reserved_delta
   WHERE location_code = COALESCE(p_location_code, 'MAIN')
     AND product_slug  = p_product_slug
     AND variant_key   = COALESCE(p_variant_key, '')
     AND (quantity_on_hand + p_on_hand_delta) >= 0
     AND ((quantity_on_hand + p_on_hand_delta) - (quantity_reserved + p_reserved_delta)) >= 0
  RETURNING * INTO v_inventory;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'insufficient_stock'
      USING ERRCODE = '23514',
            DETAIL  = format('product_slug=%s variant_key=%s tipo=%s deltas=(%s,%s)',
                             p_product_slug, COALESCE(p_variant_key, ''),
                             p_movement_type, p_on_hand_delta, p_reserved_delta),
            HINT    = 'No hay disponible suficiente. Vuelve a leer inventory.quantity_available antes de reintentar.';
  END IF;

  INSERT INTO inventory_movements (
    inventory_id, order_id, order_item_id, movement_type,
    on_hand_delta, reserved_delta, on_hand_after, reserved_after,
    reason, performed_by, idempotency_key
  ) VALUES (
    v_inventory.id, p_order_id, p_order_item_id, p_movement_type,
    p_on_hand_delta, p_reserved_delta, v_inventory.quantity_on_hand, v_inventory.quantity_reserved,
    p_reason, COALESCE(p_performed_by, current_user), p_idempotency_key
  )
  RETURNING * INTO v_movement;

  RETURN v_movement;
END $$;

-- 8.7 Reservar / liberar / confirmar el stock de un pedido -------------------
-- Las tres son transaccionales: si una línea falla, no se reserva nada.

CREATE OR REPLACE FUNCTION inventory_reserve_order(
  p_order_id      UUID,
  p_location_code TEXT DEFAULT 'MAIN'
)
RETURNS INTEGER                                             -- líneas reservadas
LANGUAGE plpgsql
AS $$
DECLARE
  v_item  RECORD;
  v_count INTEGER := 0;
BEGIN
  FOR v_item IN
    SELECT id, product_slug, variant_key, quantity
      FROM order_items
     WHERE order_id = p_order_id
     ORDER BY line_number
  LOOP
    PERFORM inventory_apply_movement(
      p_product_slug    => v_item.product_slug,
      p_variant_key     => v_item.variant_key,
      p_movement_type   => 'reservation',
      p_reserved_delta  => v_item.quantity,
      p_location_code   => p_location_code,
      p_order_id        => p_order_id,
      p_order_item_id   => v_item.id,
      p_reason          => 'order reservation',
      p_performed_by    => 'system',
      p_idempotency_key => 'reserve:' || p_order_id::TEXT || ':' || v_item.id::TEXT
    );
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END $$;

CREATE OR REPLACE FUNCTION inventory_release_order(
  p_order_id UUID,
  p_reason   TEXT DEFAULT 'cancelled'
)
RETURNS INTEGER                                             -- líneas liberadas
LANGUAGE plpgsql
AS $$
DECLARE
  v_item  RECORD;
  v_count INTEGER := 0;
BEGIN
  -- Solo libera lo que realmente está retenido y aún no se convirtió en venta.
  FOR v_item IN
    SELECT oi.id, oi.product_slug, oi.variant_key, oi.quantity
      FROM order_items oi
     WHERE oi.order_id = p_order_id
       AND EXISTS (
             SELECT 1 FROM inventory_movements m
              WHERE m.order_item_id = oi.id AND m.movement_type = 'reservation')
       AND NOT EXISTS (
             SELECT 1 FROM inventory_movements m
              WHERE m.order_item_id = oi.id
                AND m.movement_type IN ('reservation_release', 'sale'))
     ORDER BY oi.line_number
  LOOP
    PERFORM inventory_apply_movement(
      p_product_slug    => v_item.product_slug,
      p_variant_key     => v_item.variant_key,
      p_movement_type   => 'reservation_release',
      p_reserved_delta  => -v_item.quantity,
      p_order_id        => p_order_id,
      p_order_item_id   => v_item.id,
      p_reason          => p_reason,
      p_performed_by    => 'system',
      p_idempotency_key => 'release:' || p_order_id::TEXT || ':' || v_item.id::TEXT
    );
    v_count := v_count + 1;
  END LOOP;

  -- Solo marca el pedido si realmente se liberó algo (evita bloquear el reaper).
  IF v_count > 0 THEN
    UPDATE orders SET reservation_released = TRUE WHERE id = p_order_id;
  END IF;

  RETURN v_count;
END $$;

-- La reserva se convierte en salida real de stock (al retirar / entregar).
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

-- 8.8 Reaper de reservas vencidas ------------------------------------------
-- Pégalo a un cron (Vercel Cron / GitHub Action) cada minuto:
--   SELECT expire_stale_orders(200);
CREATE OR REPLACE FUNCTION expire_stale_orders(p_limit INTEGER DEFAULT 100)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_order RECORD;
  v_count INTEGER := 0;
BEGIN
  FOR v_order IN
    SELECT id
      FROM orders
     WHERE status = 'pending_payment'
       AND reservation_released = FALSE
       AND reservation_expires_at IS NOT NULL
       AND reservation_expires_at < NOW()
     ORDER BY reservation_expires_at
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  LOOP
    -- Primero libera stock (si falla, la transacción completa se revierte).
    PERFORM inventory_release_order(v_order.id, 'reservation_timeout');

    UPDATE orders
       SET status = 'expired',
           cancelled_reason = COALESCE(cancelled_reason, 'reservation_timeout')
     WHERE id = v_order.id;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END $$;

-- 8.9 Emisión de códigos de Locker -----------------------------------------
-- Alfabeto sin caracteres ambiguos (sin 0/O/1/I/L) para dictado telefónico.
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
  -- Un único código vigente por pedido: los previos se revocan.
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
      -- Colisión de código: reintenta con otro.
      CONTINUE;
    END;
  END LOOP;

  RAISE EXCEPTION 'pickup_code_generation_failed' USING ERRCODE = 'P0003';
END $$;

-- 8.10 Canje del código de Locker (un solo uso, atómico) --------------------
-- Devuelve un resultado en lugar de lanzar excepción: un RAISE revertiría la
-- transacción completa, incluyendo el contador de intentos y el marcado del código
-- como expirado. Por eso los fallos viajan en `error_code`:
--   pickup_code_not_found | pickup_code_expired | pickup_code_locked | pickup_code_already_used
-- (Los errores que SÍ deben abortar el checkout — insufficient_stock, etc. — siguen
--  usando RAISE, que es justo el efecto deseado ahí.)
CREATE OR REPLACE FUNCTION redeem_pickup_code(
  p_code        TEXT,
  p_redeemed_by TEXT DEFAULT NULL
)
RETURNS TABLE (
  ok             BOOLEAN,
  error_code     TEXT,
  pickup_code_id UUID,
  order_id       UUID,
  order_number   TEXT,
  locker_code    TEXT,
  locker_slot    TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_row   pickup_codes;
  v_error TEXT;
BEGIN
  -- Bloquea la fila: dos lecturas simultáneas del mismo código no pueden ambas ganar.
  SELECT * INTO v_row
    FROM pickup_codes
   WHERE code = upper(btrim(p_code))
   ORDER BY created_at DESC
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    v_error := 'pickup_code_not_found';

  ELSIF v_row.status = 'redeemed' THEN
    UPDATE pickup_codes SET attempts = attempts + 1 WHERE id = v_row.id;
    v_error := 'pickup_code_already_used';

  ELSIF v_row.status IN ('revoked', 'expired') THEN
    v_error := 'pickup_code_expired';

  ELSIF v_row.expires_at <= NOW() THEN
    -- Housekeeping perezoso: el código queda marcado y libera su lugar.
    UPDATE pickup_codes
       SET status = 'expired', attempts = attempts + 1
     WHERE id = v_row.id
       AND status = 'issued';
    v_error := 'pickup_code_expired';

  ELSIF v_row.attempts >= v_row.max_attempts THEN
    UPDATE pickup_codes
       SET status = 'revoked', revoked_at = NOW(),
           revocation_reason = 'max_attempts_exceeded', attempts = attempts + 1
     WHERE id = v_row.id;
    v_error := 'pickup_code_locked';
  END IF;

  IF v_error IS NOT NULL THEN
    RETURN QUERY
      SELECT FALSE, v_error, NULL::UUID, NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  -- Consumo único: el WHERE status = 'issued' hace imposible el doble canje concurrente.
  UPDATE pickup_codes
     SET status = 'redeemed',
         redeemed_at = NOW(),
         redeemed_by = p_redeemed_by,
         attempts = attempts + 1
   WHERE id = v_row.id
     AND status = 'issued'
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RETURN QUERY
      SELECT FALSE, 'pickup_code_already_used'::TEXT, NULL::UUID, NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  -- El pedido avanza por la máquina de estados (el trigger valida y sella el hito).
  UPDATE orders
     SET status = 'picked_up'
   WHERE id = v_row.order_id
     AND status = 'ready_for_pickup';

  IF NOT FOUND THEN
    RAISE NOTICE 'redeem_pickup_code: código % canjeado, pero el pedido % no estaba en ready_for_pickup',
      v_row.code, v_row.order_id;
  END IF;

  RETURN QUERY
    SELECT TRUE, NULL::TEXT, v_row.id, v_row.order_id, o.order_number, v_row.locker_code, v_row.locker_slot
      FROM orders o
     WHERE o.id = v_row.order_id;
END $$;

-- 8.11 Enganche de triggers -------------------------------------------------
DROP TRIGGER IF EXISTS trg_customers_updated_at ON customers;
CREATE TRIGGER trg_customers_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_orders_updated_at ON orders;
CREATE TRIGGER trg_orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_orders_status_guard ON orders;
CREATE TRIGGER trg_orders_status_guard
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION enforce_order_status_transition();

DROP TRIGGER IF EXISTS trg_order_items_updated_at ON order_items;
CREATE TRIGGER trg_order_items_updated_at
  BEFORE UPDATE ON order_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_order_items_lock ON order_items;
CREATE TRIGGER trg_order_items_lock
  BEFORE INSERT OR UPDATE OR DELETE ON order_items
  FOR EACH ROW EXECUTE FUNCTION guard_order_items_mutation();

DROP TRIGGER IF EXISTS trg_inventory_updated_at ON inventory;
CREATE TRIGGER trg_inventory_updated_at
  BEFORE UPDATE ON inventory
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_inventory_movements_append_only ON inventory_movements;
CREATE TRIGGER trg_inventory_movements_append_only
  BEFORE UPDATE OR DELETE ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

DROP TRIGGER IF EXISTS trg_pickup_codes_updated_at ON pickup_codes;
CREATE TRIGGER trg_pickup_codes_updated_at
  BEFORE UPDATE ON pickup_codes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
--  9. SEGURIDAD (Supabase)
--     El motor transaccional NO se expone a clientes: solo lo tocan las rutas
--     de servidor (service-role o conexión directa, que ignoran RLS por ser
--     owner/service_role). Sin políticas => anon/authenticated no ven nada.
-- =============================================================================

ALTER TABLE customers                ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items              ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory                ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_movements      ENABLE ROW LEVEL SECURITY;
ALTER TABLE pickup_codes             ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_status_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_status_history     ENABLE ROW LEVEL SECURITY;

-- (Opcional) lectura del catálogo de stock para el storefront con la anon key:
-- CREATE POLICY inventory_public_read ON inventory
--   FOR SELECT TO anon, authenticated
--   USING (is_active = TRUE);

-- =============================================================================
--  10. VERIFICACIÓN RÁPIDA (descomenta para probar en un entorno de staging)
-- =============================================================================
-- \set ON_ERROR_STOP on
-- SELECT * FROM order_status_transitions ORDER BY from_status, to_status;
-- SELECT inventory_apply_movement('demo-sku', '', 'receipt', 10, 0, 'MAIN');
-- SELECT inventory_apply_movement('demo-sku', '', 'reservation', 0, 10, 'MAIN');   -- ok: 10 disponibles
-- SELECT inventory_apply_movement('demo-sku', '', 'reservation', 0, 1,  'MAIN');   -- ERROR insufficient_stock

COMMIT;

-- =============================================================================
--  SIGUIENTE PASO (Fase 2): rutas de API que consumen estas funciones
--    POST /api/orders                 → INSERT orders (pending_payment) + items
--                                       + inventory_reserve_order()
--    POST /api/orders/[id]/confirm    → status = 'confirmed' (+ payment_status)
--    POST /api/orders/[id]/ready      → status = 'ready_for_pickup' + issue_pickup_code()
--    POST /api/locker/redeem          → redeem_pickup_code() + inventory_commit_order()
--    POST /api/orders/[id]/cancel     → status = 'cancelled' + inventory_release_order()
--    GET  /api/cron/expire-reservations → expire_stale_orders()
-- =============================================================================
-- <<<<<<<<<< END db/migrations/001_commerce_core.sql >>>>>>>>>>

-- >>>>>>>>>> BEGIN db/migrations/002_payment_confirmation.sql <<<<<<<<<<
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
-- <<<<<<<<<< END db/migrations/002_payment_confirmation.sql >>>>>>>>>>

-- >>>>>>>>>> BEGIN db/migrations/003_pickup_pin_kiosk.sql <<<<<<<<<<
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
-- <<<<<<<<<< END db/migrations/003_pickup_pin_kiosk.sql >>>>>>>>>>

