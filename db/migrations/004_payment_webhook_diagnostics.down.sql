-- Reversa de 004_payment_webhook_diagnostics.sql.
--
-- Borra SOLO la tabla de diagnóstico. Es data de observabilidad descartable: perderla
-- no afecta pedidos, stock ni pagos. El webhook sigue funcionando igual sin la tabla
-- (la escritura es best-effort y falla en silencio).
--
-- OJO: no revierte ningún comportamiento porque esta migración no cambia ninguno.

BEGIN;

DROP TABLE IF EXISTS payment_webhook_events;

COMMIT;
