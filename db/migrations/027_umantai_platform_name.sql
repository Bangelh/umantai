-- =============================================================================
--  Umantai · El nombre de la plataforma no es una tienda — 027
--  Archivo: db/migrations/027_umantai_platform_name.sql
--
--  QUÉ CAMBIA
--    · refuerza `reserved_store_slugs.umantai` (ya existía desde 011);
--    · agrega la misma reserva para el NOMBRE comercial exacto ("Umantai",
--      con o sin tildes/mayúsculas), aunque el slug sea otro;
--    · elimina la excepción del trigger que dejaba existir a la tienda legacy
--      con id 00000000-…-0001 y slug `umantai`;
--    · borra esa fila legacy si sigue vacía (sin inventario ni pedidos).
--
--  POR QUÉ
--    `umantai.com/umantai` es la marca del servicio, no un comercio. La app ya
--    reserva el slug; la base lo aplica también para que ningún script lo evite.
--
--  IDEMPOTENTE. No toca datos de tiendas reales.
-- =============================================================================

BEGIN;

INSERT INTO reserved_store_slugs (slug, reason)
VALUES ('umantai', 'marca de la plataforma')
ON CONFLICT (slug) DO UPDATE SET reason = EXCLUDED.reason;

-- La tienda legacy nunca fue un comercio: si sigue vacía, se retira. Si tuviera
-- inventario o pedidos, no se borra (el ledger es RESTRICT y no se reescribe).
DELETE FROM stores s
 WHERE s.id = '00000000-0000-0000-0000-000000000001'::uuid
   AND lower(s.slug) = 'umantai'
   AND NOT EXISTS (SELECT 1 FROM inventory i WHERE i.store_id = s.id)
   AND NOT EXISTS (SELECT 1 FROM inventory_movements m WHERE m.store_id = s.id)
   AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.store_id = s.id);

CREATE OR REPLACE FUNCTION stores_validate_slug()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.slug := lower(btrim(NEW.slug));

  -- El nombre de la plataforma no puede ser el de una tienda, aunque el slug
  -- elegido sea distinto. Se normaliza como la búsqueda (016): sin tildes.
  IF normalize_search_text(NEW.name) = 'umantai' THEN
    RAISE EXCEPTION 'reserved_store_name: umantai'
      USING ERRCODE = '22023',
            HINT = 'UMANTAI es el nombre de la plataforma. Elige otro nombre comercial.';
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
