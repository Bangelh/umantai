-- =============================================================================
--  010 — BANDEJA DEL FORMULARIO DE CONTACTO (forward-only)
--
--  QUÉ HACE
--    · `contact_messages`: guarda el mensaje ANTES de intentar el correo, para
--      no perderlo si Resend falla o no está configurado.
--
--  PRIVACIDAD
--    · No se guarda IP ni user-agent: solo lo que la persona escribió.
--    · No hay tokens ni datos de pago en esta tabla.
--
--  INVARIANTES
--    · Idempotente (`IF NOT EXISTS`). No toca 001–009 ni tablas existentes.
--
--  ROLLBACK
--    DROP TABLE IF EXISTS contact_messages;
--
--  APLICACIÓN
--    Solo staging/scratch. Nunca Producción sin autorización de cutover.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS contact_messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  name          TEXT NOT NULL
                CHECK (char_length(name) BETWEEN 2 AND 80),
  email         TEXT NOT NULL
                CHECK (char_length(email) BETWEEN 5 AND 254 AND email LIKE '%_@_%._%'),
  phone         TEXT
                CHECK (phone IS NULL OR char_length(phone) <= 30),
  message       TEXT NOT NULL
                CHECK (char_length(message) BETWEEN 10 AND 2000),

  source        TEXT NOT NULL DEFAULT 'contact_page'
                CHECK (char_length(source) <= 40),

  -- Resultado del intento de aviso por correo. El mensaje ya está guardado.
  email_status  TEXT NOT NULL DEFAULT 'pending'
                CHECK (email_status IN ('pending', 'sent', 'failed', 'not_configured')),

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contact_messages_created_at
  ON contact_messages (created_at DESC);

COMMIT;

-- =============================================================================
--  VERIFICACIÓN
--    SELECT to_regclass('public.contact_messages');
--    -- Debe devolver contact_messages.
-- =============================================================================
