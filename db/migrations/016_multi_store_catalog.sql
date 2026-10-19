-- =============================================================================
--  Umantai · Multi-Store Catalog — 016
--  Archivo: db/migrations/016_multi_store_catalog.sql
--
--  QUÉ AGREGA
--    · normalización de búsqueda para español (sin depender de `unaccent`)
--    · MasterProduct: normalized_name, attributes, archived_at + identidad única
--    · StoreProduct: normalized_name, option_schema, archived_at
--    · product_variants: combinaciones vendibles con SKU y variant_key estables
--    · order_items.variant_sku: snapshot de la variante vendida
--    · media_assets: storage fallback en base (bytea) para staging sin R2/S3
--
--  INVARIANTES
--    · `variant_key` es la identidad estable que comparte `inventory`:
--      (store_id, product_slug, variant_key). Un producto sin variantes usa ''.
--    · El stock no se copia a `store_products`: sigue viviendo en `inventory`.
--    · Un producto archivado no se borra: las líneas históricas conservan su
--      snapshot (nombre, variante, precio, total).
--    · `slug` sigue siendo único DENTRO de la tienda, nunca global.
--
--  IDEMPOTENTE.
-- =============================================================================

BEGIN;

-- =============================================================================
--  1. NORMALIZACIÓN DE BÚSQUEDA (español)
-- =============================================================================
-- `unaccent` es una extensión contrib, pero no está garantizada en todos los
-- planes de Railway. Esta función cubre los acentos del español sin extensión
-- y es IMMUTABLE para poder indexarla. La app usa el mismo criterio en JS
-- (`normalizeSearchText`).
CREATE OR REPLACE FUNCTION normalize_search_text(value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT btrim(
    regexp_replace(
      translate(
        lower(coalesce(value, '')),
        'áàäâãéèëêíìïîóòöôõúùüûñç',
        'aaaaaeeeeiiiiooooouuuunc'
      ),
      '\s+', ' ', 'g'
    )
  );
$$;

-- =============================================================================
--  2. MASTER PRODUCTS
-- =============================================================================

ALTER TABLE master_products ADD COLUMN IF NOT EXISTS normalized_name TEXT NOT NULL DEFAULT '';
ALTER TABLE master_products ADD COLUMN IF NOT EXISTS attributes JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE master_products ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

UPDATE master_products
   SET normalized_name = normalize_search_text(name)
 WHERE normalized_name = '';

CREATE OR REPLACE FUNCTION set_catalog_normalized_name()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.normalized_name := normalize_search_text(NEW.name);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS master_products_normalized_name ON master_products;
CREATE TRIGGER master_products_normalized_name
  BEFORE INSERT OR UPDATE OF name ON master_products
  FOR EACH ROW EXECUTE FUNCTION set_catalog_normalized_name();

-- Evita duplicar el mismo producto canónico (nombre + marca). La app devuelve
-- 409 con el producto existente; el índice cierra la carrera entre requests.
CREATE UNIQUE INDEX IF NOT EXISTS uq_master_products_identity
  ON master_products (normalized_name, normalize_search_text(COALESCE(brand, '')))
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_master_products_normalized_trgm
  ON master_products USING gin (normalized_name gin_trgm_ops)
  WHERE archived_at IS NULL;

-- =============================================================================
--  3. STORE PRODUCTS
-- =============================================================================

ALTER TABLE store_products ADD COLUMN IF NOT EXISTS normalized_name TEXT NOT NULL DEFAULT '';
ALTER TABLE store_products ADD COLUMN IF NOT EXISTS option_schema JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE store_products ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

UPDATE store_products
   SET normalized_name = normalize_search_text(name)
 WHERE normalized_name = '';

DROP TRIGGER IF EXISTS store_products_normalized_name ON store_products;
CREATE TRIGGER store_products_normalized_name
  BEFORE INSERT OR UPDATE OF name ON store_products
  FOR EACH ROW EXECUTE FUNCTION set_catalog_normalized_name();

CREATE INDEX IF NOT EXISTS idx_store_products_normalized_trgm
  ON store_products USING gin (normalized_name gin_trgm_ops)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_store_products_store_archived
  ON store_products (store_id, archived_at, visible);

-- =============================================================================
--  4. VARIANTES VENDIBLES
-- =============================================================================

CREATE TABLE IF NOT EXISTS product_variants (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id           UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  store_product_id   UUID NOT NULL REFERENCES store_products(id) ON DELETE CASCADE,

  -- Identidad estable que comparte `inventory`:
  -- `color:negro|talla:m` (claves y valores normalizados, ordenados).
  variant_key        TEXT NOT NULL CHECK (length(variant_key) BETWEEN 1 AND 500),
  -- SKU legible, único por tienda.
  sku                TEXT NOT NULL CHECK (length(btrim(sku)) BETWEEN 1 AND 80),
  -- { "talla": "M", "color": "negro" } — etiquetas originales.
  option_values      JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- NULL = usa el precio del StoreProduct.
  price_cents        BIGINT CHECK (price_cents IS NULL OR price_cents >= 0),

  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  archived_at        TIMESTAMPTZ,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT product_variants_product_key_unique UNIQUE (store_product_id, variant_key),
  CONSTRAINT product_variants_store_sku_unique UNIQUE (store_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_product_variants_product
  ON product_variants (store_product_id)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_product_variants_store_active
  ON product_variants (store_id, is_active)
  WHERE archived_at IS NULL;

DROP TRIGGER IF EXISTS product_variants_set_updated_at ON product_variants;
CREATE TRIGGER product_variants_set_updated_at
  BEFORE UPDATE ON product_variants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
--  5. SNAPSHOT DE LA VARIANTE EN EL PEDIDO
-- =============================================================================

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS variant_sku TEXT;

-- =============================================================================
--  6. STORAGE FALLBACK (DB) PARA IMÁGENES
-- =============================================================================
-- Driver por defecto de staging mientras no existan credenciales R2/S3. El
-- binario se sirve por `/api/media/<object_key>`; nunca se expone una ruta del
-- filesystem ni se acepta una key enviada por el usuario.
CREATE TABLE IF NOT EXISTS media_assets (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope              TEXT NOT NULL CHECK (scope IN ('store_logo', 'store_banner', 'product_image', 'master_image')),
  object_key         TEXT NOT NULL UNIQUE CHECK (
    object_key ~ '^[a-z0-9][a-z0-9/_.-]{7,180}$'
    AND position('..' IN object_key) = 0
  ),
  mime               TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes         INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 2097152),
  -- `db` guarda el binario; `r2` solo metadatos (el objeto vive en el bucket).
  storage_driver     TEXT NOT NULL DEFAULT 'db' CHECK (storage_driver IN ('db', 'r2')),
  data               BYTEA,

  store_id           UUID REFERENCES stores(id) ON DELETE CASCADE,
  store_product_id   UUID REFERENCES store_products(id) ON DELETE SET NULL,
  master_product_id  UUID REFERENCES master_products(id) ON DELETE SET NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at        TIMESTAMPTZ,

  CONSTRAINT media_assets_data_chk CHECK (
    (storage_driver = 'db' AND data IS NOT NULL)
    OR (storage_driver = 'r2' AND data IS NULL)
  ),

  CONSTRAINT media_assets_owner_chk CHECK (
    (scope = 'store_logo' AND store_id IS NOT NULL AND store_product_id IS NULL AND master_product_id IS NULL)
    OR (scope = 'store_banner' AND store_id IS NOT NULL AND store_product_id IS NULL AND master_product_id IS NULL)
    OR (scope = 'product_image' AND store_id IS NOT NULL AND store_product_id IS NOT NULL AND master_product_id IS NULL)
    OR (scope = 'master_image' AND master_product_id IS NOT NULL AND store_id IS NULL AND store_product_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_media_assets_store
  ON media_assets (store_id, created_at DESC)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_media_assets_master
  ON media_assets (master_product_id, created_at DESC)
  WHERE archived_at IS NULL;

COMMIT;
