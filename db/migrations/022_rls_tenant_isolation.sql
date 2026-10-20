-- =============================================================================
--  Umantai · THEME + I18N + HARDENING — 022
--  Archivo: db/migrations/022_rls_tenant_isolation.sql
--
--  QUÉ HACE
--    Segunda barrera REAL de aislamiento entre tiendas:
--
--      · habilita Row-Level Security en las tablas con `store_id`;
--      · crea (si se puede) el rol NO OWNER `umantai_tenant` (NOLOGIN,
--        NOBYPASSRLS) y le da permisos solo sobre esas tablas;
--      · cada fila visible/escribible exige que la transacción haya fijado
--        `app.store_id` con `set_config('app.store_id', '<uuid>', true)`.
--
--  POR QUÉ NO ROMPE LA APP ACTUAL
--    El dueño del schema (rol de `DATABASE_URL`) IGNORA RLS salvo que se use
--    `FORCE ROW LEVEL SECURITY`. No se fuerza a propósito: la app actual sigue
--    funcionando con su rol dueño y su segunda barrera es el trigger de tenant
--    (020) + validaciones de `requireStoreAccess`. La RLS es la barrera para un
--    futuro rol de aplicación sin privilegios.
--
--  CÓMO SE USA (futuro)
--    BEGIN;
--      SELECT set_config('app.store_id', '<uuid-de-la-tienda>', true);
--      -- queries sin store_id quedan acotadas por policy
--    COMMIT;
--
--  EXCEPCIONES DOCUMENTADAS
--    · `orders` necesita lectura global para el link público `/pedido/<token>`.
--      Ese acceso NO usa el rol tenant: la ruta consulta con el rol dueño y
--      filtra por `public_token`. Con el rol tenant solo se ve la tienda fijada.
--    · Funciones SECURITY DEFINER de inventario/reservas siguen ejecutándose
--      como dueño; por eso no se ven afectadas.
--
--  IDEMPOTENTE.
-- =============================================================================

BEGIN;

-- 1. Rol de aplicación sin privilegios (si el usuario de migración puede).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'umantai_tenant') THEN
    BEGIN
      CREATE ROLE umantai_tenant NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'umantai_tenant no se pudo crear (sin privilegios); RLS queda activa igual.';
    END;
  END IF;
END $$;

-- 2. RLS en las tablas con store_id de la lista prioritaria.
ALTER TABLE store_products        ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_variants      ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory             ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_movements   ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders                ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_subscriptions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE promotion_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items           ENABLE ROW LEVEL SECURITY;

-- 3. Policies: una sola condición, repetida a propósito para que sea legible
--    en `\d+` y no dependa de una función que alguien pueda cambiar.
DROP POLICY IF EXISTS tenant_isolation ON store_products;
CREATE POLICY tenant_isolation ON store_products
  USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (store_id = nullif(current_setting('app.store_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON product_variants;
CREATE POLICY tenant_isolation ON product_variants
  USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (store_id = nullif(current_setting('app.store_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON inventory;
CREATE POLICY tenant_isolation ON inventory
  USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (store_id = nullif(current_setting('app.store_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON inventory_movements;
CREATE POLICY tenant_isolation ON inventory_movements
  USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (store_id = nullif(current_setting('app.store_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON orders;
CREATE POLICY tenant_isolation ON orders
  USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (store_id = nullif(current_setting('app.store_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON store_subscriptions;
CREATE POLICY tenant_isolation ON store_subscriptions
  USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (store_id = nullif(current_setting('app.store_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON promotion_redemptions;
CREATE POLICY tenant_isolation ON promotion_redemptions
  USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (store_id = nullif(current_setting('app.store_id', true), '')::uuid);

-- order_items no tiene store_id: se acota por su pedido padre. La subconsulta
-- vuelve a pasar por la policy de `orders`, así que no hay forma de “salir” de
-- la tienda fijada.
DROP POLICY IF EXISTS tenant_isolation ON order_items;
CREATE POLICY tenant_isolation ON order_items
  USING (
    EXISTS (
      SELECT 1 FROM orders o
       WHERE o.id = order_items.order_id
         AND o.store_id = nullif(current_setting('app.store_id', true), '')::uuid
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM orders o
       WHERE o.id = order_items.order_id
         AND o.store_id = nullif(current_setting('app.store_id', true), '')::uuid
    )
  );

-- 4. Permisos del rol tenant. Si el rol no se pudo crear, no se otorga nada.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'umantai_tenant') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO umantai_tenant';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON store_products, product_variants, inventory, inventory_movements, orders, order_items, store_subscriptions, promotion_redemptions TO umantai_tenant';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO umantai_tenant';
    EXECUTE 'GRANT SELECT ON stores TO umantai_tenant';
  END IF;
END $$;

COMMIT;
