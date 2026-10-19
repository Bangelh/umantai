-- =============================================================================
--  Umantai · Multi-Tenant Foundation — 012
--  Archivo: db/migrations/012_auth.sql
--
--  QUÉ CREA
--    · users, sessions, auth_accounts, verifications
--        Tablas de Better Auth (ver AUTH_DECISION.md). UNA sola identidad sirve
--        como cliente y como comerciante; no hay dos sistemas de usuarios.
--        Las columnas conservan el camelCase que espera Better Auth
--        (`"emailVerified"`, `"userId"`, …) y la tabla se renombra vía
--        `modelName` en `lib/auth.server.ts`.
--    · customer_profiles  datos de perfil que no pertenecen a Better Auth.
--    · store_members       pertenencia usuario ↔ tienda + rol (owner/admin).
--
--  POR QUÉ NO HAY RLS ACÁ
--    La app usa UN rol de Postgres (el dueño del schema), así que RLS no
--    aportaría aislamiento real. El enforcement vive en `lib/tenancy.server.ts`
--    (toda consulta store-scoped exige `storeId` + membresía) y se prueba en
--    `tests/multi-tenant.integration.test.ts`. Endurecer con un rol no-owner +
--    RLS queda documentado como deuda.
--
--  IDEMPOTENTE: se puede re-ejecutar.
-- =============================================================================

BEGIN;

-- =============================================================================
--  1. IDENTIDADES (Better Auth)
-- =============================================================================

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL,
  "emailVerified" BOOLEAN NOT NULL DEFAULT FALSE,
  image           TEXT,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Better Auth consulta por email exacto; normalizamos a minúsculas al registrar
-- y al iniciar sesión. El índice case-insensitive protege igual.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email
  ON users (lower(email));

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  token       TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId"    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sessions_token ON sessions (token);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions ("userId", "expiresAt" DESC);

CREATE TABLE IF NOT EXISTS auth_accounts (
  id                      TEXT PRIMARY KEY,
  "accountId"             TEXT NOT NULL,
  "providerId"            TEXT NOT NULL,
  "userId"                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "accessToken"           TEXT,
  "refreshToken"          TEXT,
  "idToken"               TEXT,
  "accessTokenExpiresAt"  TIMESTAMPTZ,
  "refreshTokenExpiresAt" TIMESTAMPTZ,
  scope                   TEXT,
  password                TEXT,
  "createdAt"             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_accounts_provider_account
  ON auth_accounts ("providerId", "accountId");
CREATE INDEX IF NOT EXISTS idx_auth_accounts_user
  ON auth_accounts ("userId");

CREATE TABLE IF NOT EXISTS verifications (
  id          TEXT PRIMARY KEY,
  identifier  TEXT NOT NULL,
  value       TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_verifications_identifier
  ON verifications (identifier);

-- =============================================================================
--  2. PERFIL DE CLIENTE
--     Lo mínimo para una cuenta: nombre visible y datos de contacto. El
--     historial de pedidos sale de `orders` (por `user_id` o email verificado).
-- =============================================================================

CREATE TABLE IF NOT EXISTS customer_profiles (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  full_name     TEXT,
  phone         TEXT,
  doc_type      TEXT,
  doc_number    TEXT,
  default_address JSONB,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
--  3. MEMBRESÍA A TIENDAS
--     Un usuario puede pertenecer a VARIAS tiendas. Roles mínimos: owner/admin.
--     Los permisos se resuelven en servidor; el rol nunca se confía del cliente.
-- =============================================================================

CREATE TABLE IF NOT EXISTS store_members (
  store_id    UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('owner', 'admin')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (store_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_store_members_user
  ON store_members (user_id, created_at DESC);

DROP TRIGGER IF EXISTS store_members_set_updated_at ON store_members;
CREATE TRIGGER store_members_set_updated_at
  BEFORE UPDATE ON store_members
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
