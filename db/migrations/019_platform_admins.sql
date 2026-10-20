-- =============================================================================
--  Umantai · THEME + I18N + HARDENING — 019
--  Archivo: db/migrations/019_platform_admins.sql
--
--  QUÉ CREA
--    platform_admins: usuarios de Better Auth autorizados a operar el panel de
--    plataforma (/admin, /admin/planes, APIs /api/admin/*).
--
--  POR QUÉ
--    El token compartido (ADMIN_API_SECRET) no identifica a la persona ni deja
--    auditoría. La autorización real se apoya en la sesión de Better Auth y en
--    esta tabla; el token queda solo como respaldo de desarrollo.
--
--  BOOTSTRAP
--    El primer admin se otorga con `npm run admin:grant -- correo@dominio` o,
--    temporalmente, con `PLATFORM_ADMIN_EMAILS` (lista separada por comas).
--
--  IDEMPOTENTE.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS platform_admins (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  granted_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_admins_created
  ON platform_admins (created_at DESC);

COMMIT;
