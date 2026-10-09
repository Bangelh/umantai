-- =============================================================================
--  007 (rollback) — restaura `inventory_release_order` a la definición de 001.
--
--  Solo para revertir la migración 007. Vuelve al predicado histórico (ciego a las
--  re-reservas) y a la clave de idempotencia fija. NO toca datos.
--
--    psql "$POSTGRES_URL_NON_POOLING" -f db/migrations/007_release_respects_rereservation.down.sql
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION inventory_release_order(
  p_order_id UUID,
  p_reason   TEXT DEFAULT 'cancelled'
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

  IF v_count > 0 THEN
    UPDATE orders SET reservation_released = TRUE WHERE id = p_order_id;
  END IF;

  RETURN v_count;
END $$;

COMMIT;
