-- =============================================================================
--  Umantai · LIBRO DE RECLAMACIONES — RESPONSABLE — 024
--  Archivo: db/migrations/024_complaint_assignment.sql
--
--  QUÉ AGREGA
--    · assigned_to: persona o rol que responde. Al registrarse queda el
--      responsable operativo por defecto; al tomar la hoja, el Platform Admin
--      que la revisa.
--    · assigned_at: cuándo se asignó por última vez.
--    · answered_by: quién emitió la respuesta (historial mínimo de respuesta).
--
--  POR QUÉ
--    El responsable operativo inicial es el Platform Admin de UMANTAI. Guardar
--    el actor y la fecha deja evidencia ante una fiscalización y evita que una
--    respuesta quede sin autor identificable. No se publica ningún nombre
--    personal en el formulario ni en la constancia.
--
--  IDEMPOTENTE. No borra ni reescribe filas existentes.
-- =============================================================================

BEGIN;

ALTER TABLE consumer_complaints
  ADD COLUMN IF NOT EXISTS assigned_to TEXT NOT NULL DEFAULT 'Platform Admin (UMANTAI)';

ALTER TABLE consumer_complaints
  ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;

ALTER TABLE consumer_complaints
  ADD COLUMN IF NOT EXISTS answered_by TEXT;

COMMENT ON COLUMN consumer_complaints.assigned_to IS
  'Responsable de atender la hoja. Inicialmente el rol Platform Admin (UMANTAI); luego el admin que la toma.';

COMMENT ON COLUMN consumer_complaints.assigned_at IS
  'Fecha de asignación al responsable actual.';

COMMENT ON COLUMN consumer_complaints.answered_by IS
  'Platform Admin que emitió la respuesta. Parte del historial mínimo de respuesta.';

COMMIT;
