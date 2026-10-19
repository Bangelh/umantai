-- =============================================================================
--  009 — ÍNDICE DE FECHAS PARA ANALYTICS (forward-only)
--
--  PROBLEMA
--    El dashboard filtra `orders` por rango de fechas y agrupa por día/semana.
--    `001` indexa por estado y por expiración, pero no por `created_at`; con
--    volumen el rango recorre la tabla completa.
--
--  QUÉ HACE
--    · `idx_orders_created_at` → rango por fecha y orden descendente.
--
--  INVARIANTES
--    · No cambia datos, funciones ni triggers.
--    · Idempotente (`IF NOT EXISTS`). No toca 001–008.
--
--  ROLLBACK
--    DROP INDEX IF EXISTS idx_orders_created_at;
--
--  APLICACIÓN
--    Solo staging/scratch. Nunca Producción sin autorización de cutover.
-- =============================================================================

BEGIN;

CREATE INDEX IF NOT EXISTS idx_orders_created_at
  ON orders (created_at DESC);

COMMIT;

-- =============================================================================
--  VERIFICACIÓN
--    SELECT indexname FROM pg_indexes
--     WHERE tablename = 'orders' AND indexname = 'idx_orders_created_at';
--    -- Debe devolver 1 fila.
-- =============================================================================
