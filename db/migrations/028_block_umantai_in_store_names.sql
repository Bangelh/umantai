-- =============================================================================
--  Umantai · La marca no aparece en nombres de tiendas — 028
--  Archivo: db/migrations/028_block_umantai_in_store_names.sql
--
--  QUÉ CAMBIA
--    El trigger de identidad ya rechazaba el nombre exacto "Umantai" (027).
--    Ahora rechaza cualquier nombre que CONTENGA la marca, sin importar
--    mayúsculas, tildes o palabras alrededor: "Umantai Store", "Bodega UMANTAI",
--    "Comercial Umántai SAC".
--
--  POR QUÉ
--    `umantai.com/<tienda>` debe identificar a un comercio, no a la plataforma.
--    La app aplica la misma regla en `isReservedStoreName()`.
--
--  IDEMPOTENTE. No toca datos existentes.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION stores_validate_slug()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.slug := lower(btrim(NEW.slug));

  -- Marca de la plataforma: se busca como subcadena en el nombre normalizado.
  IF position('umantai' IN normalize_search_text(NEW.name)) > 0 THEN
    RAISE EXCEPTION 'reserved_store_name: umantai'
      USING ERRCODE = '22023',
            HINT = 'El nombre no puede contener UMANTAI, la marca de la plataforma.';
  END IF;

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
  BEFORE INSERT OR UPDATE OF name, slug ON stores
  FOR EACH ROW EXECUTE FUNCTION stores_validate_slug();

COMMIT;
