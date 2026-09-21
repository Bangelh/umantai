-- =============================================================================
--  Umantai · Rollback de la Fase 1 (motor transaccional)
--  Archivo: db/migrations/001_commerce_core.down.sql
--
--  ⚠️  DESTRUCTIVO: elimina pedidos, clientes, stock y el ledger de movimientos.
--      Úsalo solo en desarrollo/staging o si hay que rehacer la migración.
--      En producción, haz un backup lógico antes:
--        pg_dump "$POSTGRES_URL_NON_POOLING" --table='public.orders' ... > backup.sql
--
--  Orden inverso al de creación para respetar las dependencias (FKs).
-- =============================================================================

BEGIN;

-- 1. Triggers
DROP TRIGGER IF EXISTS trg_pickup_codes_updated_at        ON pickup_codes;
DROP TRIGGER IF EXISTS trg_inventory_movements_append_only ON inventory_movements;
DROP TRIGGER IF EXISTS trg_inventory_updated_at           ON inventory;
DROP TRIGGER IF EXISTS trg_order_items_lock               ON order_items;
DROP TRIGGER IF EXISTS trg_order_items_updated_at         ON order_items;
DROP TRIGGER IF EXISTS trg_orders_status_guard            ON orders;
DROP TRIGGER IF EXISTS trg_orders_updated_at              ON orders;
DROP TRIGGER IF EXISTS trg_customers_updated_at           ON customers;

-- 2. Funciones
DROP FUNCTION IF EXISTS redeem_pickup_code(TEXT, TEXT);
DROP FUNCTION IF EXISTS issue_pickup_code(UUID, TEXT, TEXT, INTERVAL, INTEGER);
DROP FUNCTION IF EXISTS expire_stale_orders(INTEGER);
DROP FUNCTION IF EXISTS inventory_commit_order(UUID, TEXT);
DROP FUNCTION IF EXISTS inventory_release_order(UUID, TEXT);
DROP FUNCTION IF EXISTS inventory_reserve_order(UUID, TEXT);
DROP FUNCTION IF EXISTS inventory_apply_movement(TEXT, TEXT, inventory_movement_type, INTEGER, INTEGER, TEXT, UUID, UUID, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS refresh_order_totals_from_items(UUID);
DROP FUNCTION IF EXISTS guard_order_items_mutation();
DROP FUNCTION IF EXISTS prevent_ledger_mutation();
DROP FUNCTION IF EXISTS enforce_order_status_transition();
DROP FUNCTION IF EXISTS set_updated_at();

-- 3. Tablas (primero las que tienen FKs hacia otras)
DROP TABLE IF EXISTS order_status_history;
DROP TABLE IF EXISTS order_status_transitions;
DROP TABLE IF EXISTS pickup_codes;
DROP TABLE IF EXISTS inventory_movements;
DROP TABLE IF EXISTS inventory;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS customers;

-- 4. Tipos enumerados
DROP TYPE IF EXISTS pickup_code_status;
DROP TYPE IF EXISTS inventory_movement_type;
DROP TYPE IF EXISTS payment_status;
DROP TYPE IF EXISTS fulfillment_type;
DROP TYPE IF EXISTS order_channel;
DROP TYPE IF EXISTS order_status;

-- 5. Secuencia del correlativo
DROP SEQUENCE IF EXISTS order_number_seq;

COMMIT;
