-- =============================================================================
--  Umantai · Ubicación estructurada de tienda — 025
--  Archivo: db/migrations/025_store_location_ubigeo.sql
--
--  QUÉ CREA
--    · ubigeo_departments / ubigeo_provinces / ubigeo_districts
--      Catálogo oficial INEI (código de 6 dígitos: 2 dep + 2 prov + 2 dist),
--      con el centroide del distrito para centrar el mapa. El snapshot que se
--      carga vive en 026_seed_ubigeo.sql (generado por scripts/build-ubigeo.mjs).
--    · stores.ubigeo  → referencia administrativa CANÓNICA.
--    · stores.department / stores.province / stores.district / stores.city
--      pasan a ser DERIVADOS del ubigeo por trigger: una sola fuente de verdad.
--    · stores.reference, stores.location_source, stores.location_updated_at
--      (dato operativo de la ubicación, no administrativo).
--
--  QUÉ NO CAMBIA
--    · stores.latitude / longitude siguen siendo la fuente de verdad del PIN y
--      lo único que usa la búsqueda por distancia (Haversine + bounding box).
--    · stores_active_location_chk sigue exigiendo lat/lng para activar.
--    · Ninguna tienda existente se toca: ubigeo NULL es un estado válido.
--
--  REGLA DE SINCRONIZACIÓN
--    ubigeo es canónico. Al escribirlo, el trigger sobrescribe department,
--    province, district y city con los nombres oficiales. Sin ubigeo, los campos
--    derivados quedan NULL y district/city conservan su valor legacy (texto
--    libre) para no romper vitrinas antiguas.
--
--  IDEMPOTENTE: se puede re-ejecutar.
-- =============================================================================

BEGIN;

-- =============================================================================
--  1. CATÁLOGO UBIGEO (INEI)
-- =============================================================================

CREATE TABLE IF NOT EXISTS ubigeo_departments (
  code TEXT PRIMARY KEY CHECK (code ~ '^[0-9]{2}$'),
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 80)
);

CREATE TABLE IF NOT EXISTS ubigeo_provinces (
  code            TEXT PRIMARY KEY CHECK (code ~ '^[0-9]{4}$'),
  department_code TEXT NOT NULL REFERENCES ubigeo_departments(code) ON DELETE RESTRICT,
  name            TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 80)
);

CREATE TABLE IF NOT EXISTS ubigeo_districts (
  code          TEXT PRIMARY KEY CHECK (code ~ '^[0-9]{6}$'),
  province_code TEXT NOT NULL REFERENCES ubigeo_provinces(code) ON DELETE RESTRICT,
  name          TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 80),
  -- Centroide del distrito: sirve para centrar el mapa y como advertencia de
  -- cordura. NO son los límites administrativos reales.
  latitude      DOUBLE PRECISION CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  longitude     DOUBLE PRECISION CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180)
);

CREATE INDEX IF NOT EXISTS idx_ubigeo_provinces_department
  ON ubigeo_provinces (department_code);

CREATE INDEX IF NOT EXISTS idx_ubigeo_districts_province
  ON ubigeo_districts (province_code);

-- Búsqueda por nombre normalizado (reverse geocoding → ubigeo).
CREATE INDEX IF NOT EXISTS idx_ubigeo_districts_name
  ON ubigeo_districts (lower(name));

-- =============================================================================
--  2. COLUMNAS NUEVAS EN STORES
-- =============================================================================

ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS ubigeo TEXT,
  ADD COLUMN IF NOT EXISTS department TEXT,
  ADD COLUMN IF NOT EXISTS province TEXT,
  ADD COLUMN IF NOT EXISTS reference TEXT,
  ADD COLUMN IF NOT EXISTS location_source TEXT,
  ADD COLUMN IF NOT EXISTS location_updated_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stores_ubigeo_fk'
  ) THEN
    ALTER TABLE stores
      ADD CONSTRAINT stores_ubigeo_fk
      FOREIGN KEY (ubigeo) REFERENCES ubigeo_districts(code) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stores_ubigeo_format_chk'
  ) THEN
    ALTER TABLE stores
      ADD CONSTRAINT stores_ubigeo_format_chk
      CHECK (ubigeo IS NULL OR ubigeo ~ '^[0-9]{6}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stores_reference_len_chk'
  ) THEN
    ALTER TABLE stores
      ADD CONSTRAINT stores_reference_len_chk
      CHECK (reference IS NULL OR length(btrim(reference)) <= 120);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stores_address_len_chk'
  ) THEN
    ALTER TABLE stores
      ADD CONSTRAINT stores_address_len_chk
      CHECK (address IS NULL OR length(btrim(address)) BETWEEN 3 AND 200);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stores_location_source_chk'
  ) THEN
    ALTER TABLE stores
      ADD CONSTRAINT stores_location_source_chk
      CHECK (
        location_source IS NULL
        OR location_source IN ('map_pin', 'gps', 'geocoder', 'legacy_zone')
      );
  END IF;

  -- El pin corresponde a un punto del Perú. Se valida en la DB además del
  -- servidor: ningún script puede insertar coordenadas de otro país.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stores_pin_in_peru_chk'
  ) THEN
    ALTER TABLE stores
      ADD CONSTRAINT stores_pin_in_peru_chk
      CHECK (
        latitude IS NULL
        OR (
          latitude BETWEEN -18.6 AND 0.1
          AND longitude BETWEEN -81.5 AND -68.6
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_stores_ubigeo
  ON stores (ubigeo)
  WHERE ubigeo IS NOT NULL;

-- =============================================================================
--  3. SINCRONIZACIÓN ubigeo → nombres administrativos
--     Un solo lugar decide los nombres. La app NUNCA escribe department,
--     province, district ni city: los deriva el trigger desde el ubigeo.
-- =============================================================================

CREATE OR REPLACE FUNCTION stores_sync_ubigeo_names()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  names RECORD;
BEGIN
  IF NEW.ubigeo IS NULL THEN
    -- Sin referencia administrativa: los derivados no tienen sentido. Se
    -- conservan district/city legacy para no vaciar vitrinas antiguas.
    NEW.department := NULL;
    NEW.province := NULL;
    RETURN NEW;
  END IF;

  SELECT d.name AS department, p.name AS province, di.name AS district
    INTO names
    FROM ubigeo_districts di
    JOIN ubigeo_provinces p ON p.code = di.province_code
    JOIN ubigeo_departments d ON d.code = p.department_code
   WHERE di.code = NEW.ubigeo;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_ubigeo: %', NEW.ubigeo
      USING ERRCODE = '23503',
            HINT = 'El código UBIGEO no existe en el catálogo (ver 026_seed_ubigeo.sql).';
  END IF;

  NEW.department := names.department;
  NEW.province := names.province;
  NEW.district := names.district;
  -- `city` es legacy de presentación: se mantiene alineado a la provincia.
  NEW.city := names.province;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS stores_sync_ubigeo ON stores;
CREATE TRIGGER stores_sync_ubigeo
  BEFORE INSERT OR UPDATE ON stores
  FOR EACH ROW EXECUTE FUNCTION stores_sync_ubigeo_names();

COMMIT;
