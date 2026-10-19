-- =============================================================================
--  008 — ÍNDICES DEL LEDGER PARA FILTROS DEL ADMIN (forward-only)
--
--  PROBLEMA
--    El listado global de movimientos filtra por tipo y rango de fechas, y ordena
--    por `created_at DESC`. `001` solo indexa `(inventory_id, created_at)` y
--    `(order_id, created_at)`; sin un índice por fecha, el panel recorre todo el
--    ledger. Con volumen bajo no se nota, pero es barato dejarlo preparado.
--
--  QUÉ HACE
--    · `idx_inventory_movements_created_at` → orden global por fecha.
--    · `idx_inventory_movements_type_created` → filtro por tipo + fecha.
--
--  INVARIANTES
--    · No cambia datos ni funciones. El ledger sigue siendo append-only.
--    · `IF NOT EXISTS` hace la migración idempotente.
--    · No toca 001–007.
--
--  ROLLBACK
--    DROP INDEX IF EXISTS idx_inventory_movements_type_created;
--    DROP INDEX IF EXISTS idx_inventory_movements_created_at;
--
--  APLICACIÓN
--    Solo staging/scratch. Nunca Producción sin autorización de cutover.
-- =============================================================================

BEGIN;

CREATE INDEX IF NOT EXISTS idx_inventory_movements_created_at
  ON inventory_movements (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_inventory_movements_type_created
  ON inventory_movements (movement_type, created_at DESC);

COMMIT;

-- =============================================================================
--  VERIFICACIÓN
--    SELECT indexname FROM pg_indexes
--     WHERE tablename = 'inventory_movements'
--       AND indexname IN ('idx_inventory_movements_created_at',
--                         'idx_inventory_movements_type_created');
--    -- Debe devolver 2 filas.
-- =============================================================================
