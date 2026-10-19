-- =============================================================================
--  Umantai · Multi-Tenant Foundation — 013
--  Archivo: db/migrations/013_catalog.sql
--
--  QUÉ CREA
--    · master_products  catálogo canónico GLOBAL (nombre, marca, categoría,
--                       descripción base, imagen opcional).
--    · store_products   lo que cada comercio vende: precio PROPIO, visibilidad,
--                       nombre/override y vínculo opcional al maestro.
--
--  REGLAS
--    · Un StoreProduct puede existir SIN master_product_id (producto propio de
--      la tienda). El buscador indexa ambos casos.
--    · El precio vive en centavos enteros (nunca float) y siempre es de la
--      tienda; el maestro no tiene precio.
--    · `slug` es único DENTRO de la tienda. Dos tiendas pueden vender el mismo
--      producto con el mismo slug sin colisionar.
--    · La disponibilidad NO se guarda acá: se deriva de `inventory`
--      (store_id + product_slug + variant_key = '').
--
--  IDEMPOTENTE.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS master_products (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            TEXT NOT NULL,
  name            TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  brand           TEXT,
  category        TEXT,
  description     TEXT,
  image_url       TEXT,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_master_products_slug
  ON master_products (slug);
CREATE INDEX IF NOT EXISTS idx_master_products_category
  ON master_products (lower(category), lower(name))
  WHERE active;

DROP TRIGGER IF EXISTS master_products_set_updated_at ON master_products;
CREATE TRIGGER master_products_set_updated_at
  BEFORE UPDATE ON master_products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS store_products (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id           UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  master_product_id  UUID REFERENCES master_products(id) ON DELETE SET NULL,

  slug               TEXT NOT NULL,
  name               TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  brand              TEXT,
  category           TEXT,
  description        TEXT,
  image_url          TEXT,

  price_cents        BIGINT NOT NULL CHECK (price_cents >= 0),
  currency           TEXT NOT NULL DEFAULT 'PEN' CHECK (currency ~ '^[A-Z]{3}$'),
  unit               TEXT NOT NULL DEFAULT 'unidad',

  visible            BOOLEAN NOT NULL DEFAULT TRUE,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT store_products_store_slug_unique UNIQUE (store_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_store_products_store_visible
  ON store_products (store_id, lower(name))
  WHERE visible;
CREATE INDEX IF NOT EXISTS idx_store_products_master
  ON store_products (master_product_id)
  WHERE master_product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_store_products_category
  ON store_products (lower(category))
  WHERE visible;

DROP TRIGGER IF EXISTS store_products_set_updated_at ON store_products;
CREATE TRIGGER store_products_set_updated_at
  BEFORE UPDATE ON store_products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
