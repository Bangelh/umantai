-- =============================================================================
--  Umantai · Multi-Tenant Foundation — 011
--  Archivo: db/migrations/011_stores.sql
--
--  QUÉ CREA
--    · stores                 raíz de tenancy (una fila por comercio)
--    · reserved_store_slugs   rutas que un comercio NUNCA puede reclamar
--    · trigger de validación  slug normalizado, formato y reservados (en la DB,
--                             no solo en la app)
--
--  GEOLOCALIZACIÓN
--    `latitude`/`longitude` en grados decimales. Se indexan con un btree
--    compuesto para que el pre-filtro por bounding box sea barato; la distancia
--    exacta se calcula con Haversine en la consulta (sin PostGIS).
--    Una tienda activa DEBE tener ubicación: si no, no puede aparecer en el
--    buscador y el constraint lo impide explícitamente.
--
--  TIENDA LEGACY
--    El catálogo de la fase 1 (productos base + inventario) pertenece a una
--    tienda interna con UUID fijo `00000000-0000-0000-0000-000000000001`.
--    Queda `active = FALSE` (no es un comercio descubrible) y `is_default = TRUE`
--    (destino de los pedidos/inventario históricos que no declaran tienda).
--
--  IDEMPOTENTE: se puede re-ejecutar.
-- =============================================================================

BEGIN;

-- =============================================================================
--  1. STORES
-- =============================================================================

CREATE TABLE IF NOT EXISTS stores (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  name            TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 80),
  slug            TEXT NOT NULL,
  description     TEXT,

  logo_url        TEXT,
  image_url       TEXT,
  -- Rubro libre (abarrotes, ropa, telas, ferretería…). NO se asume abarrotes:
  -- UMANTAI es un buscador local de cualquier categoría.
  category        TEXT,

  address         TEXT,
  district        TEXT,
  city            TEXT,
  latitude        DOUBLE PRECISION CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  longitude       DOUBLE PRECISION CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),

  contact_email   TEXT,
  contact_phone   TEXT,

  active          BOOLEAN NOT NULL DEFAULT FALSE,
  is_default      BOOLEAN NOT NULL DEFAULT FALSE,
  approved_at     TIMESTAMPTZ,

  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Una tienda visible en el buscador necesita ubicación. Se puede crear
  -- inactiva mientras el equipo valida el alta.
  CONSTRAINT stores_active_location_chk
    CHECK (NOT active OR (latitude IS NOT NULL AND longitude IS NOT NULL))
);

-- Slug case-insensitive único. El trigger lo guarda ya en minúsculas.
CREATE UNIQUE INDEX IF NOT EXISTS uq_stores_slug
  ON stores (lower(slug));

-- Sólo puede existir una tienda por defecto.
CREATE UNIQUE INDEX IF NOT EXISTS uq_stores_default
  ON stores ((is_default))
  WHERE is_default;

-- Pre-filtro geográfico (bounding box) + listados del buscador.
CREATE INDEX IF NOT EXISTS idx_stores_geo_active
  ON stores (latitude, longitude)
  WHERE active AND latitude IS NOT NULL AND longitude IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_stores_active_category
  ON stores (lower(category), lower(name))
  WHERE active;

DROP TRIGGER IF EXISTS stores_set_updated_at ON stores;
CREATE TRIGGER stores_set_updated_at
  BEFORE UPDATE ON stores
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
--  2. SLUGS RESERVADOS
--     Todo lo que YA ocupa una ruta de primer nivel, más las rutas de sistema.
--     Se valida en la base para que ningún script pueda saltarse la regla.
-- =============================================================================

CREATE TABLE IF NOT EXISTS reserved_store_slugs (
  slug    TEXT PRIMARY KEY,
  reason  TEXT
);

INSERT INTO reserved_store_slugs (slug, reason) VALUES
  ('admin',      'panel de administración'),
  ('api',        'rutas de API'),
  ('login',      'autenticación'),
  ('ingresar',   'autenticación'),
  ('registro',   'alta de identidad'),
  ('legal',      'páginas legales'),
  ('contacto',   'formulario de contacto'),
  ('products',   'catálogo legacy'),
  ('cart',       'carrito'),
  ('list',       'lista de compras'),
  ('kiosk',      'kiosco de retiro'),
  ('kiosco',     'kiosco de retiro'),
  ('pedido',     'detalle público de pedido'),
  ('cuenta',     'cuenta de cliente'),
  ('negocio',    'panel de comerciante'),
  ('vender',     'alta de comercio'),
  ('search',     'buscador'),
  ('buscar',     'buscador'),
  ('debug',      'diagnóstico'),
  ('_next',      'assets de Next.js'),
  ('favicon.ico','asset del sitio'),
  ('robots.txt', 'SEO'),
  ('sitemap.xml','SEO'),
  ('brand',      'assets de marca'),
  ('images',     'assets de producto'),
  ('umantai',    'marca de la plataforma / tienda legacy')
ON CONFLICT (slug) DO NOTHING;

-- =============================================================================
--  3. VALIDACIÓN DEL SLUG EN LA BASE
--     Formato: 3–60 caracteres, minúsculas/números/guiones, sin guiones en los
--     extremos. Reservados bloqueados. `umantai` sólo existe por la tienda
--     legacy ya sembrada: el trigger deja actualizar esa fila sin cambiar el slug.
-- =============================================================================

CREATE OR REPLACE FUNCTION stores_validate_slug()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- La fila legacy es la única excepción: su slug pertenece a la plataforma.
  IF NEW.id = '00000000-0000-0000-0000-000000000001'::uuid
     AND lower(btrim(NEW.slug)) = 'umantai' THEN
    NEW.slug := 'umantai';
    RETURN NEW;
  END IF;

  NEW.slug := lower(btrim(NEW.slug));

  IF NEW.slug !~ '^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$' THEN
    RAISE EXCEPTION 'invalid_store_slug: "%"', NEW.slug
      USING ERRCODE = '22023',
            HINT = 'Usa entre 3 y 60 caracteres: minúsculas, números y guiones (sin guion al inicio/fin).';
  END IF;

  IF NEW.slug ~ '--' THEN
    RAISE EXCEPTION 'invalid_store_slug: "%" (guiones consecutivos)', NEW.slug
      USING ERRCODE = '22023';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM reserved_store_slugs r WHERE r.slug = NEW.slug) THEN
      RAISE EXCEPTION 'reserved_store_slug: %', NEW.slug
        USING ERRCODE = '23505',
              HINT = 'Ese slug es una ruta del sistema. Elige otro nombre comercial.';
    END IF;
  ELSIF NEW.slug IS DISTINCT FROM OLD.slug THEN
    IF EXISTS (SELECT 1 FROM reserved_store_slugs r WHERE r.slug = NEW.slug) THEN
      RAISE EXCEPTION 'reserved_store_slug: %', NEW.slug
        USING ERRCODE = '23505';
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS stores_slug_guard ON stores;
CREATE TRIGGER stores_slug_guard
  BEFORE INSERT OR UPDATE OF slug ON stores
  FOR EACH ROW EXECUTE FUNCTION stores_validate_slug();

-- =============================================================================
--  4. TIENDA LEGACY / DEFAULT
--     UUID fijo: es el `DEFAULT` de orders/inventory a partir de 014. No es un
--     comercio real; existe para que el catálogo histórico tenga un dueño.
-- =============================================================================

INSERT INTO stores (
  id, name, slug, description, category,
  active, is_default
) VALUES (
  '00000000-0000-0000-0000-000000000001'::uuid,
  'Umantai',
  'umantai',
  'Catálogo heredado de la fase 1 (productos base, inventario y pedidos previos al multi-tienda).',
  'general',
  FALSE,
  TRUE
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
