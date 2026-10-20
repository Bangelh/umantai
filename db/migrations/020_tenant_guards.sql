-- =============================================================================
--  Umantai · THEME + I18N + HARDENING — 020
--  Archivo: db/migrations/020_tenant_guards.sql
--
--  QUÉ HACE
--    Segunda barrera de aislamiento: un asset de una tienda no puede apuntar a
--    un producto de OTRA tienda, aunque una ruta tenga un bug. La aplicación ya
--    valida el scope; esto lo impone también PostgreSQL.
--
--  RLS
--    La app usa un único rol dueño del schema (`DATABASE_URL`), así que RLS no
--    aportaría aislamiento real sin separar roles y setear `app.current_user`.
--    Esa migración queda documentada como deuda en SECURITY_HARDENING.md.
--
--  IDEMPOTENTE.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION assert_media_asset_tenant_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.store_product_id IS NOT NULL THEN
    IF NEW.store_id IS NULL THEN
      RAISE EXCEPTION 'media_store_required: un asset de producto necesita store_id'
        USING HINT = 'Asigna la tienda dueña del producto.';
    END IF;

    PERFORM 1
      FROM store_products sp
     WHERE sp.id = NEW.store_product_id
       AND sp.store_id = NEW.store_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'media_store_scope_mismatch: el producto no pertenece a la tienda'
        USING HINT = 'No se puede adjuntar una imagen a un producto de otra tienda.';
    END IF;
  END IF;

  IF NEW.master_product_id IS NOT NULL AND NEW.store_id IS NOT NULL THEN
    RAISE EXCEPTION 'media_scope_conflict: un asset no puede ser de tienda y de catálogo maestro a la vez';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS media_assets_tenant_scope ON media_assets;
CREATE TRIGGER media_assets_tenant_scope
  BEFORE INSERT OR UPDATE OF store_id, store_product_id, master_product_id ON media_assets
  FOR EACH ROW EXECUTE FUNCTION assert_media_asset_tenant_scope();

COMMIT;
