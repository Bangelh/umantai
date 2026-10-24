-- =============================================================================
--  Umantai · LIBRO DE RECLAMACIONES — 023
--  Archivo: db/migrations/023_consumer_complaints.sql
--
--  QUÉ CREA
--    consumer_complaints: registro del Libro de Reclamaciones virtual (Perú,
--    Ley N.º 29571 y D.S. N.º 011-2011-PCM). Incluye los campos mínimos del
--    Anexo I y el plazo de respuesta de 15 días hábiles.
--
--  DECISIONES
--    · `complaint_number` es correlativo y visible en la constancia.
--    · `public_code` es aleatorio y NO secuencial: es la única llave para
--      consultar la constancia sin login. Así el número correlativo no permite
--      enumerar reclamaciones ajenas.
--    · No se guarda DNI/teléfono del consumidor en ningún índice de búsqueda
--      pública ni en `public_code`.
--    · No hay borrado desde la aplicación: el historial debe conservarse para
--      poder acreditar la atención ante INDECOPI.
--
--  IDEMPOTENTE.
-- =============================================================================

BEGIN;

CREATE SEQUENCE IF NOT EXISTS consumer_complaints_number_seq START WITH 1;

CREATE TABLE IF NOT EXISTS consumer_complaints (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_number  BIGINT NOT NULL UNIQUE DEFAULT nextval('consumer_complaints_number_seq'),
  public_code       TEXT NOT NULL UNIQUE,
  kind              TEXT NOT NULL CHECK (kind IN ('reclamo', 'queja')),

  consumer_name     TEXT NOT NULL,
  consumer_document TEXT NOT NULL,
  consumer_phone    TEXT NOT NULL,
  consumer_email    TEXT NOT NULL,
  is_minor          BOOLEAN NOT NULL DEFAULT FALSE,
  guardian_name     TEXT,
  guardian_document TEXT,

  related_item      TEXT NOT NULL,
  amount_cents      BIGINT CHECK (amount_cents IS NULL OR amount_cents >= 0),
  currency          TEXT NOT NULL DEFAULT 'PEN',

  detail            TEXT NOT NULL,
  consumer_request  TEXT NOT NULL,

  status            TEXT NOT NULL DEFAULT 'received'
                    CHECK (status IN ('received', 'in_review', 'answered')),
  provider_actions  TEXT,
  response_text     TEXT,

  submitted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  due_at            TIMESTAMPTZ NOT NULL,
  responded_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Los datos del padre/tutor van juntos o no van.
  CONSTRAINT consumer_complaints_guardian_pair
    CHECK ((guardian_name IS NULL) = (guardian_document IS NULL)),
  -- Una respuesta cerrada exige texto y fecha.
  CONSTRAINT consumer_complaints_answered_fields
    CHECK (status <> 'answered' OR (response_text IS NOT NULL AND responded_at IS NOT NULL)),
  CONSTRAINT consumer_complaints_currency_pen CHECK (currency = 'PEN')
);

-- Operación: vencidos y próximos a vencer primero.
CREATE INDEX IF NOT EXISTS idx_consumer_complaints_due
  ON consumer_complaints (due_at)
  WHERE status <> 'answered';

CREATE INDEX IF NOT EXISTS idx_consumer_complaints_status_submitted
  ON consumer_complaints (status, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_consumer_complaints_kind_submitted
  ON consumer_complaints (kind, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_consumer_complaints_submitted
  ON consumer_complaints (submitted_at DESC);

COMMENT ON TABLE consumer_complaints IS
  'Libro de Reclamaciones virtual. No se borra desde la aplicación.';
COMMENT ON COLUMN consumer_complaints.public_code IS
  'Código aleatorio no secuencial para constancia/seguimiento sin login.';
COMMENT ON COLUMN consumer_complaints.due_at IS
  'Fecha límite de respuesta: 15 días hábiles (solo se excluyen sábados y domingos; sin feriados).';

COMMIT;
