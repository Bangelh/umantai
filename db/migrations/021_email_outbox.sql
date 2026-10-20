-- =============================================================================
--  Umantai · THEME + I18N + HARDENING — 021
--  Archivo: db/migrations/021_email_outbox.sql
--
--  QUÉ CREA
--    email_outbox: bandeja de salida para el MODO TEST de correo.
--
--  POR QUÉ
--    La verificación de email y la recuperación de contraseña necesitan un
--    enlace con token. En staging no hay dominio verificado en Resend, así que
--    el provider `test` guarda el mensaje acá (nunca lo envía) y un endpoint
--    protegido permite al E2E leerlo. En Producción esta tabla no se usa: el
--    provider es Resend o el envío falla cerrado.
--
--  SEGURIDAD
--    · Solo se escribe cuando AUTH_TEST_MODE=1 Y el entorno NO es Producción.
--    · El endpoint de lectura exige ese mismo flag y está rate-limited.
--    · Se guarda el token en el enlace; por eso la tabla tiene expiración y la
--      limpieza puede borrar filas viejas sin afectar nada más.
--
--  IDEMPOTENTE.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS email_outbox (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose     TEXT NOT NULL,
  recipient   TEXT NOT NULL,
  subject     TEXT NOT NULL,
  body_text   TEXT NOT NULL,
  action_url  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_email_outbox_recipient_created
  ON email_outbox (recipient, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_outbox_expires
  ON email_outbox (expires_at);

COMMIT;
