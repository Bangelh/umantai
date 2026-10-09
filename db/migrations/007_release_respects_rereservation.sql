-- =============================================================================
--  007 — LIBERAR LÍNEAS RE-RESERVADAS (forward-only)
--
--  PROBLEMA QUE RESUELVE (evidencia real en Preview: UM-2026-001017 /
--  47b73c57-7984-4564-8d48-9edaad79ee92)
--
--  `inventory_release_order()` (001) seleccionaba las líneas con:
--      EXISTS (reservation)  AND  NOT EXISTS (reservation_release | sale)
--  Ese predicado es CIEGO a una línea que se liberó y luego se RE-RESERVÓ por un pago
--  tardío (`inventory_rereserve_order`, 002). Secuencia real observada:
--      reservation +1  →  reservation_release -1  →  reservation +1
--  El último movimiento del ciclo vuelve a ser `reservation`, así que la línea SÍ
--  retiene stock, pero como tiene un `reservation_release` ANTERIOR el filtro la
--  excluía y nunca se liberaba. Resultado: `inventory.quantity_reserved` quedaba
--  varado en 1 con el pedido ya en `cancelled` (reconciliación: ledger consistente,
--  matchesInventory = true → no era desincronización del contador).
--
--  QUÉ HACE
--   1. `inventory_release_order` pasa a usar la definición AUTORITATIVA de "reserva
--      viva" (la MISMA que `inventory_rereserve_order`): el ÚLTIMO movimiento del
--      ciclo (`reservation`/`reservation_release`/`sale`) por línea debe ser
--      `reservation`, ordenando por `created_at DESC, id DESC`.
--   2. La clave de idempotencia deja de ser fija para las liberaciones POSTERIORES a
--      la primera. Con la clave fija `release:<order>:<item>`, un segundo release
--      encontraría el movimiento existente y `inventory_apply_movement()` lo
--      devolvería SIN aplicar el delta (capa 3) → la corrección de (1) sería INERTE.
--      Ahora: la PRIMERA liberación conserva la clave histórica
--      `release:<order>:<item>` (no reescribe histórico) y las siguientes usan
--      `release:<order>:<item>:<n>` con n = nº de releases previos + 1. Así cada
--      re-reserva puede liberarse una vez, y un reintento del MISMO cancel sigue
--      siendo idempotente (el predicado ya no ve la línea como viva).
--
--  ALCANCE: SOLO redefine `inventory_release_order`. No toca datos, `inventory`,
--  `on_hand`, estados ni el ledger, y no aplica ningún backfill.
--
--  COPIAS HISTÓRICAS (NO se reescriben; esta migración es la autoridad final):
--    · db/migrations/001_commerce_core.sql           → definición original (histórica)
--    · db/migrations/commerce-preview-initial.sql    → consolidado de Preview (histórico)
--  Ninguna migración entre 002 y 006 redefinió esta función.
--
--  IDEMPOTENTE: re-ejecutarla deja la misma función.
--  REVERSIBLE: db/migrations/007_release_respects_rereservation.down.sql
--
--  CÓMO APLICARLA (SOLO Preview):
--    psql "$POSTGRES_URL_NON_POOLING" -f db/migrations/007_release_respects_rereservation.sql
--    o pegar el contenido completo en el SQL Editor de la rama de Preview.
-- =============================================================================

BEGIN;

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
  -- Solo libera lo que RETIENE stock HOY: el último movimiento del ciclo de la línea
  -- debe ser `reservation`. Cubre `reservation → reservation_release → reservation`
  -- (re-reserva por pago tardío), que el predicado anterior ignoraba.
  FOR v_item IN
    SELECT oi.id, oi.product_slug, oi.variant_key, oi.quantity,
           (SELECT COUNT(*)
              FROM inventory_movements m
             WHERE m.order_item_id = oi.id
               AND m.movement_type = 'reservation_release') AS prior_releases
      FROM order_items oi
     WHERE oi.order_id = p_order_id
       AND (
             SELECT m.movement_type
               FROM inventory_movements m
              WHERE m.order_item_id = oi.id
                AND m.movement_type IN ('reservation', 'reservation_release', 'sale')
              ORDER BY m.created_at DESC, m.id DESC
              LIMIT 1
           ) = 'reservation'
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
      -- Clave por evento: la primera conserva el formato histórico; las siguientes
      -- (tras una re-reserva) llevan sufijo para que el movimiento SÍ se aplique.
      p_idempotency_key => CASE
                             WHEN v_item.prior_releases > 0
                             THEN 'release:' || p_order_id::TEXT || ':' || v_item.id::TEXT
                                  || ':' || (v_item.prior_releases + 1)::TEXT
                             ELSE 'release:' || p_order_id::TEXT || ':' || v_item.id::TEXT
                           END
    );
    v_count := v_count + 1;
  END LOOP;

  -- Solo marca el pedido si realmente se liberó algo (evita bloquear el reaper).
  IF v_count > 0 THEN
    UPDATE orders SET reservation_released = TRUE WHERE id = p_order_id;
  END IF;

  RETURN v_count;
END $$;

COMMIT;

-- =============================================================================
--  VERIFICACIÓN (opcional, en rama de desarrollo; NO ejecutar en Preview sin
--  autorización). Ensayo en seco dentro de una transacción que se revierte:
--
--   BEGIN;
--     -- Debe devolver 1 y agregar un `reservation_release` con reserved_delta = -1
--     -- y clave `release:<order>:<item>:2` (la línea venía re-reservada).
--     SELECT inventory_release_order('47b73c57-7984-4564-8d48-9edaad79ee92', 'dry_run');
--   ROLLBACK;
-- =============================================================================
