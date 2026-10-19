-- =============================================================================
--  Umantai · Multi-Tenant Foundation — 014
--  Archivo: db/migrations/014_store_scoping.sql
--
--  QUÉ HACE
--    · Añade `store_id` a orders, inventory e inventory_movements.
--    · Backfill EXPLÍCITO a la tienda legacy (nunca NULL silencioso).
--    · Cambia la clave única del inventario a (store_id, location_code,
--      product_slug, variant_key): el mismo SKU existe una vez POR TIENDA.
--    · Añade `orders.user_id` (nullable) para asociar compras autenticadas
--      sin romper el checkout de invitado.
--    · Reemplaza `inventory_apply_movement()` por una versión store-aware.
--
--  RESOLUCIÓN DE TIENDA EN LA FUNCIÓN
--    1. `p_store_id` explícito (panel de la tienda).
--    2. La tienda del pedido (`orders.store_id`).
--    3. La tienda legacy/default (solo para flujos históricos de la fase 1).
--    Si `p_store_id` y la tienda del pedido no coinciden, se lanza
--    `store_scope_mismatch`: jamás se mueve stock de otra tienda.
--
--  IDEMPOTENTE.
-- =============================================================================

BEGIN;

-- =============================================================================
--  1. ORDERS — dueño de la venta + comprador autenticado
-- =============================================================================

ALTER TABLE orders ADD COLUMN IF NOT EXISTS store_id UUID;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS user_id TEXT;

UPDATE orders
   SET store_id = '00000000-0000-0000-0000-000000000001'::uuid
 WHERE store_id IS NULL;

ALTER TABLE orders ALTER COLUMN store_id
  SET DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;
ALTER TABLE orders ALTER COLUMN store_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_store_fk'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT orders_store_fk
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_user_fk'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT orders_user_fk
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_orders_store_created
  ON orders (store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_store_status
  ON orders (store_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_user
  ON orders (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

-- =============================================================================
--  2. INVENTORY — una fila por tienda + local + SKU
-- =============================================================================

ALTER TABLE inventory ADD COLUMN IF NOT EXISTS store_id UUID;

UPDATE inventory
   SET store_id = '00000000-0000-0000-0000-000000000001'::uuid
 WHERE store_id IS NULL;

ALTER TABLE inventory ALTER COLUMN store_id
  SET DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;
ALTER TABLE inventory ALTER COLUMN store_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_store_fk'
  ) THEN
    ALTER TABLE inventory
      ADD CONSTRAINT inventory_store_fk
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- La unicidad pasa a ser por tienda. Se elimina la vieja restricción SOLO si
-- existe (la 001 la crea como constraint, no como índice).
ALTER TABLE inventory DROP CONSTRAINT IF EXISTS inventory_sku_unique;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_store_sku_unique'
  ) THEN
    ALTER TABLE inventory
      ADD CONSTRAINT inventory_store_sku_unique
      UNIQUE (store_id, location_code, product_slug, variant_key);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_inventory_store_product
  ON inventory (store_id, product_slug, variant_key)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_inventory_store_location
  ON inventory (store_id, location_code)
  WHERE is_active = TRUE;

-- =============================================================================
--  3. INVENTORY_MOVEMENTS — ledger por tienda
-- =============================================================================

ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS store_id UUID;

-- El ledger es append-only (`trg_inventory_movements_append_only`). El backfill
-- de una columna nueva es una migración de esquema, no una reescritura del
-- histórico: se desactiva el trigger SOLO dentro de esta transacción y se vuelve
-- a activar de inmediato. Si algo falla, el ROLLBACK deja todo como estaba.
ALTER TABLE inventory_movements DISABLE TRIGGER trg_inventory_movements_append_only;

UPDATE inventory_movements m
   SET store_id = i.store_id
  FROM inventory i
 WHERE m.inventory_id = i.id
   AND m.store_id IS NULL;

UPDATE inventory_movements
   SET store_id = '00000000-0000-0000-0000-000000000001'::uuid
 WHERE store_id IS NULL;

ALTER TABLE inventory_movements ENABLE TRIGGER trg_inventory_movements_append_only;

ALTER TABLE inventory_movements ALTER COLUMN store_id
  SET DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;
ALTER TABLE inventory_movements ALTER COLUMN store_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_movements_store_fk'
  ) THEN
    ALTER TABLE inventory_movements
      ADD CONSTRAINT inventory_movements_store_fk
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_inventory_movements_store
  ON inventory_movements (store_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_inventory_movements_store_type
  ON inventory_movements (store_id, movement_type, created_at DESC);

-- =============================================================================
--  4. FUNCIÓN STORE-AWARE
--     Se elimina la firma de 11 argumentos para que TODA llamada (posicional o
--     por nombre) resuelva a la versión nueva. El último parámetro tiene default,
--     así el código de la fase 1 sigue funcionando sin cambios.
-- =============================================================================

DROP FUNCTION IF EXISTS inventory_apply_movement(
  TEXT, TEXT, inventory_movement_type, INTEGER, INTEGER, TEXT, UUID, UUID, TEXT, TEXT, TEXT
);

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
  p_performed_by     TEXT DEFAULT NULL,
  p_idempotency_key  TEXT DEFAULT NULL,
  p_store_id         UUID DEFAULT NULL
)
RETURNS inventory_movements
LANGUAGE plpgsql
AS $$
DECLARE
  v_inventory   inventory;
  v_movement    inventory_movements;
  v_existing    inventory_movements;
  v_store       UUID;
  v_order_store UUID;
BEGIN
  IF p_on_hand_delta = 0 AND p_reserved_delta = 0 THEN
    RAISE EXCEPTION 'inventory_apply_movement: se requiere al menos un delta distinto de cero'
      USING ERRCODE = '22023';
  END IF;

  -- Tienda del pedido (si lo hay), para validar coherencia y hacer el default.
  IF p_order_id IS NOT NULL THEN
    SELECT store_id INTO v_order_store FROM orders WHERE id = p_order_id;
  END IF;

  IF p_store_id IS NOT NULL AND v_order_store IS NOT NULL AND p_store_id <> v_order_store THEN
    RAISE EXCEPTION 'store_scope_mismatch: el pedido % pertenece a otra tienda', p_order_id
      USING ERRCODE = '23514',
            HINT = 'No se puede mover inventario de una tienda con un pedido de otra.';
  END IF;

  v_store := COALESCE(
    p_store_id,
    v_order_store,
    (SELECT id FROM stores WHERE is_default LIMIT 1)
  );

  IF v_store IS NULL THEN
    RAISE EXCEPTION 'store_not_resolved: no hay tienda para el movimiento'
      USING ERRCODE = '23502';
  END IF;

  -- Idempotencia (capa 3): un reintento devuelve el mismo movimiento.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing
      FROM inventory_movements
     WHERE idempotency_key = p_idempotency_key;

    IF FOUND THEN
      IF v_existing.store_id <> v_store THEN
        RAISE EXCEPTION 'store_scope_mismatch: la clave de idempotencia pertenece a otra tienda'
          USING ERRCODE = '23514';
      END IF;
      RETURN v_existing;
    END IF;
  END IF;

  -- El SKU puede no existir todavía: se crea en cero EN ESA TIENDA.
  INSERT INTO inventory (
    store_id, location_code, product_slug, variant_key, quantity_on_hand, quantity_reserved
  )
  VALUES (
    v_store, COALESCE(p_location_code, 'MAIN'), p_product_slug, COALESCE(p_variant_key, ''), 0, 0
  )
  ON CONFLICT (store_id, location_code, product_slug, variant_key) DO NOTHING;

  -- Capa 2: UPDATE condicional atómico, ahora con el scope de tienda.
  UPDATE inventory
     SET quantity_on_hand  = quantity_on_hand  + p_on_hand_delta,
         quantity_reserved = quantity_reserved + p_reserved_delta
   WHERE store_id      = v_store
     AND location_code = COALESCE(p_location_code, 'MAIN')
     AND product_slug  = p_product_slug
     AND variant_key   = COALESCE(p_variant_key, '')
     AND (quantity_on_hand + p_on_hand_delta) >= 0
     AND ((quantity_on_hand + p_on_hand_delta) - (quantity_reserved + p_reserved_delta)) >= 0
  RETURNING * INTO v_inventory;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'insufficient_stock'
      USING ERRCODE = '23514',
            DETAIL  = format('store=%s product_slug=%s variant_key=%s tipo=%s deltas=(%s,%s)',
                             v_store, p_product_slug, COALESCE(p_variant_key, ''),
                             p_movement_type, p_on_hand_delta, p_reserved_delta),
            HINT    = 'No hay disponible suficiente en esta tienda.';
  END IF;

  INSERT INTO inventory_movements (
    inventory_id, store_id, order_id, order_item_id, movement_type,
    on_hand_delta, reserved_delta, on_hand_after, reserved_after,
    reason, performed_by, idempotency_key
  ) VALUES (
    v_inventory.id, v_store, p_order_id, p_order_item_id, p_movement_type,
    p_on_hand_delta, p_reserved_delta, v_inventory.quantity_on_hand, v_inventory.quantity_reserved,
    p_reason, COALESCE(p_performed_by, current_user), p_idempotency_key
  )
  RETURNING * INTO v_movement;

  RETURN v_movement;
END $$;

COMMIT;
