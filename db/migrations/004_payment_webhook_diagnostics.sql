-- =============================================================================
--  004 — DIAGNÓSTICO DE WEBHOOKS DE PAGO (observabilidad, NO cambia semántica)
--
--  PROBLEMA QUE RESUELVE
--  El webhook de Mercado Pago (`POST /api/payments/webhook`) devuelve 401 a las
--  notificaciones AUTOMÁTICAS reales mientras que el simulador oficial —mismo
--  endpoint, misma configuración— devuelve 200. La validación de firma usa el
--  `WebhookSignatureValidator` oficial del SDK y es correcta; para diagnosticar
--  la diferencia hace falta comparar QUÉ INPUTS recibió cada notificación.
--
--  Como no tenemos acceso fiable a los logs de Vercel desde el entorno del agente,
--  esta tabla es la superficie PERSISTENTE y consultable. Guarda SOLO metadatos NO
--  sensibles suficientes para reconstruir la validación: presencia y longitud de
--  los headers de firma, tipos/ids del query y del body, y el resultado final.
--
--  QUÉ NO SE GUARDA (por diseño)
--    · `MERCADOPAGO_WEBHOOK_SECRET`
--    · el Access Token de Mercado Pago
--    · el valor COMPLETO de `x-signature`
--    · el valor COMPLETO del hash `v1`
--    · el valor COMPLETO de `x-request-id` (solo presencia y longitud)
--    · cookies / cualquier header de autorización
--
--  La ESCRITURA es best-effort: si esta tabla no existe todavía (migración sin
--  aplicar) el webhook sigue funcionando exactamente igual.
--
--  ADITIVA: crea una tabla nueva; no modifica ninguna tabla existente.
--  IDEMPOTENTE: se puede re-ejecutar sin efectos secundarios.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS payment_webhook_events (
  -- UUID como el resto del esquema (ver 001_commerce_core.sql).
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Momento en que la ruta recibió el request (lo fija la app, no un trigger:
  -- así el reloj es el del receptor y no el del INSERT).
  received_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pathname                   TEXT,
  -- Nombres (SOLO nombres) de los query params presentes, como JSON array.
  query_param_names          JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Id del recurso notificado (`data.id`). NO es un secreto: ya aparece en el panel.
  data_id                    TEXT,
  query_data_id_present      BOOLEAN NOT NULL DEFAULT FALSE,
  query_data_id_length       INTEGER,
  -- true/false sólo cuando hay `data.id` en query Y en body; NULL si faltó alguno.
  query_data_id_matches_body BOOLEAN,

  query_type                 TEXT,
  body_type                  TEXT,
  action                     TEXT,
  live_mode                  BOOLEAN,
  body_user_id               TEXT,

  x_request_id_present       BOOLEAN NOT NULL DEFAULT FALSE,
  x_request_id_length        INTEGER,

  x_signature_present        BOOLEAN NOT NULL DEFAULT FALSE,
  signature_has_ts           BOOLEAN NOT NULL DEFAULT FALSE,
  signature_has_v1           BOOLEAN NOT NULL DEFAULT FALSE,
  ts_length                  INTEGER,
  v1_length                  INTEGER,

  user_agent                 TEXT,
  x_retry                    TEXT,

  -- Resultado de la validación. NULL = no se llegó a evaluar la firma (p. ej. 503).
  signature_ok               BOOLEAN,
  -- Etiqueta corta: 'signature_ok' | 'invalid_signature:<motivo>' | code de error.
  result                     TEXT,
  -- Código HTTP que la ruta devolvió (o se propuso devolver) para ese request.
  http_status                INTEGER
);

-- Consulta principal: "los últimos N eventos".
CREATE INDEX IF NOT EXISTS idx_payment_webhook_events_received
  ON payment_webhook_events (received_at DESC, id DESC);

-- Filtro por recurso: "todos los eventos del pago 182145601434".
CREATE INDEX IF NOT EXISTS idx_payment_webhook_events_data_id
  ON payment_webhook_events (data_id);

COMMENT ON TABLE payment_webhook_events IS
  'Diagnóstico NO sensible de los webhooks de Mercado Pago recibidos. Nunca guarda secretos, firmas completas ni request-id completos. Escritura best-effort.';
COMMENT ON COLUMN payment_webhook_events.query_data_id_matches_body IS
  'true/false sólo si `data.id` vino en query Y en body; NULL cuando falta alguno.';
COMMENT ON COLUMN payment_webhook_events.signature_ok IS
  'TRUE firma válida, FALSE inválida, NULL si no se llegó a evaluar (p. ej. 503 de configuración).';
COMMENT ON COLUMN payment_webhook_events.http_status IS
  'Código HTTP devuelto/propuesto por la ruta. Para firma inválida es 401.';
COMMENT ON COLUMN payment_webhook_events.v1_length IS
  'Longitud del hash v1. Se guarda la LONGITUD, nunca el valor.';

COMMIT;
