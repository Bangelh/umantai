-- =============================================================================
--  Umantai · Multi-Tenant Foundation — 015
--  Archivo: db/migrations/015_search_indexes.sql
--
--  BÚSQUEDA GLOBAL
--    El buscador hace `ILIKE '%texto%'` sobre nombre/marca/categoría. Un GIN con
--    pg_trgm permite ese patrón sin recorrer todas las filas. Es una extensión
--    estándar de PostgreSQL (contrib), disponible en Railway y en el Postgres
--    efímero de los tests; NO es PostGIS.
--
--  GEO
--    El pre-filtro usa un bounding box sobre (latitude, longitude) —índice de
--    011— y la distancia exacta se calcula con Haversine en SQL. No se guarda
--    ni se indexa una columna de distancia: depende del punto del usuario.
--
--  IDEMPOTENTE.
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Haversine en SQL, IMMUTABLE y PARALLEL SAFE. La usan el buscador y los tests
-- de integración; una sola definición evita que el orden de resultados y la
-- distancia mostrada se calculen con fórmulas distintas.
CREATE OR REPLACE FUNCTION geo_distance_km(
  lat1 DOUBLE PRECISION,
  lng1 DOUBLE PRECISION,
  lat2 DOUBLE PRECISION,
  lng2 DOUBLE PRECISION
)
RETURNS DOUBLE PRECISION
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT 2 * 6371.0088 * asin(
    least(1, sqrt(
      power(sin(radians(lat2 - lat1) / 2), 2)
      + cos(radians(lat1)) * cos(radians(lat2))
        * power(sin(radians(lng2 - lng1) / 2), 2)
    ))
  );
$$;

-- Productos de tienda: nombre, marca y categoría.
CREATE INDEX IF NOT EXISTS idx_store_products_name_trgm
  ON store_products USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_store_products_brand_trgm
  ON store_products USING gin (brand gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_store_products_category_trgm
  ON store_products USING gin (category gin_trgm_ops);

-- Catálogo maestro: nombre canónico y marca (para productos vinculados).
CREATE INDEX IF NOT EXISTS idx_master_products_name_trgm
  ON master_products USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_master_products_brand_trgm
  ON master_products USING gin (brand gin_trgm_ops);

-- Tiendas: nombre (búsqueda de comercios por texto).
CREATE INDEX IF NOT EXISTS idx_stores_name_trgm
  ON stores USING gin (name gin_trgm_ops);

-- Disponibilidad por tienda: el buscador agrega `inventory` por (store, slug).
CREATE INDEX IF NOT EXISTS idx_inventory_store_slug_active
  ON inventory (store_id, product_slug)
  WHERE is_active = TRUE;

COMMIT;
