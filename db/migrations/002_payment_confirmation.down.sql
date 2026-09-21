-- Reversa de 002_payment_confirmation.sql.
-- OJO: si ya hay pedidos confirmados a partir de un pago tardío, borrar la
-- transición no los revierte (el histórico queda en order_status_history), pero
-- cualquier confirmación futura de un pedido `expired` volverá a fallar.

BEGIN;

DROP FUNCTION IF EXISTS confirm_order_payment(TEXT, TEXT, TEXT, NUMERIC, TEXT, JSONB, TEXT, TEXT);
DROP FUNCTION IF EXISTS inventory_rereserve_order(UUID, TEXT);

DELETE FROM order_status_transitions
 WHERE from_status = 'expired'
   AND to_status   = 'confirmed';

COMMIT;
