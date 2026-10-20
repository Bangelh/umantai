-- =============================================================================
-- 017_plans_subscriptions.sql — planes SaaS, suscripciones y promociones
-- =============================================================================
-- Esta migración es SOLO de la capa comercial de UMANTAI:
--
--   plans                 catálogo centralizado (Free/Starter/Growth)
--   store_subscriptions   UNA suscripción principal por tienda
--   subscription_events   historial append-only (auditoría)
--   promotions            códigos de meses gratis
--   promotion_redemptions canjes idempotentes por tienda/código
--   store_sku_usage       vista ÚNICA del consumo de SKU
--
-- NO toca:
--   · Mercado Pago de PEDIDOS (mp-orders, Preferences, webhooks de pedidos)
--   · inventario, reservas, checkout ni el catálogo público
--
-- REGLA DE NEGOCIO DEL SKU (una sola definición, en la vista):
--   producto visible/no archivado sin variantes activas  → 1 SKU
--   cada variante activa/no archivada de un producto visible → 1 SKU
--   producto oculto (draft), archivado o variante inactiva/archivada → 0
--
-- La vista se usa desde `lib/billing/sku.server.ts`; no se cuenta
-- `store_products` a mano en otros lugares.
--
-- IDEMPOTENTE. Aplicar 001–017 en una base limpia (drill/test) y 017 sola en
-- staging.
-- =============================================================================

BEGIN;

-- =============================================================================
--  1. CATÁLOGO DE PLANES
-- =============================================================================
CREATE TABLE IF NOT EXISTS plans (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code             TEXT NOT NULL CHECK (code ~ '^[a-z][a-z0-9_-]{1,30}$'),
  name             TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  -- Precio en centavos. Free = 0. Moneda inicial: USD.
  price_cents      BIGINT NOT NULL CHECK (price_cents >= 0),
  currency         TEXT NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  billing_interval TEXT NOT NULL DEFAULT 'month'
                     CHECK (billing_interval IN ('month', 'year')),
  sku_limit        INTEGER NOT NULL CHECK (sku_limit > 0),
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  features         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_plans_code ON plans (lower(code));
CREATE INDEX IF NOT EXISTS idx_plans_active_sort ON plans (active, sort_order, price_cents);

DROP TRIGGER IF EXISTS plans_set_updated_at ON plans;
CREATE TRIGGER plans_set_updated_at
  BEFORE UPDATE ON plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Catálogo inicial aprobado para esta fase. El código es estable; el nombre,
-- precio y límite se pueden ajustar con migraciones posteriores.
INSERT INTO plans (code, name, price_cents, currency, billing_interval, sku_limit, active, sort_order, features)
VALUES
  ('free',    'Free',    0,   'USD', 'month', 25,  TRUE, 0, '{"label":"Para empezar"}'::jsonb),
  ('starter', 'Starter', 400, 'USD', 'month', 50,  TRUE, 1, '{"label":"Para crecer"}'::jsonb),
  ('growth',  'Growth',  600, 'USD', 'month', 100, TRUE, 2, '{"label":"Para escalar"}'::jsonb)
ON CONFLICT (lower(code)) DO UPDATE
  SET name = EXCLUDED.name,
      price_cents = EXCLUDED.price_cents,
      currency = EXCLUDED.currency,
      billing_interval = EXCLUDED.billing_interval,
      sku_limit = EXCLUDED.sku_limit,
      active = EXCLUDED.active,
      sort_order = EXCLUDED.sort_order,
      features = EXCLUDED.features,
      updated_at = NOW();

-- =============================================================================
--  2. SUSCRIPCIÓN PRINCIPAL POR TIENDA
-- =============================================================================
-- Una fila por tienda. `status` describe la relación comercial; el plan
-- efectivo vive en `plan_id`. Free NO se representa con NULL: toda tienda
-- tiene plan Free explícito desde el alta.
CREATE TABLE IF NOT EXISTS store_subscriptions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id                UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  plan_id                 UUID NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,

  status                  TEXT NOT NULL DEFAULT 'free'
                            CHECK (status IN ('free', 'trialing', 'active', 'past_due', 'cancelled', 'expired')),

  current_period_start    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_period_end      TIMESTAMPTZ,

  cancel_at_period_end    BOOLEAN NOT NULL DEFAULT FALSE,
  cancelled_at            TIMESTAMPTZ,

  provider                TEXT NOT NULL DEFAULT 'manual',
  provider_customer_id    TEXT,
  provider_subscription_id TEXT,

  -- Cambio de plan programado para el próximo período (downgrade).
  pending_plan_id         UUID REFERENCES plans(id) ON DELETE RESTRICT,
  pending_plan_effective_at TIMESTAMPTZ,

  -- Estado derivado persistido: si el consumo supera el límite del plan.
  -- No despublica nada; sólo bloquea nuevas publicaciones/activaciones.
  over_limit_at           TIMESTAMPTZ,

  metadata                JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT store_subscriptions_one_per_store UNIQUE (store_id),
  CONSTRAINT store_subscriptions_period_chk
    CHECK (current_period_end IS NULL OR current_period_end >= current_period_start),
  CONSTRAINT store_subscriptions_pending_chk
    CHECK (pending_plan_id IS NULL OR pending_plan_effective_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_store_subscriptions_status_end
  ON store_subscriptions (status, current_period_end)
  WHERE current_period_end IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_store_subscriptions_plan
  ON store_subscriptions (plan_id, status);

DROP TRIGGER IF EXISTS store_subscriptions_set_updated_at ON store_subscriptions;
CREATE TRIGGER store_subscriptions_set_updated_at
  BEFORE UPDATE ON store_subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Toda tienda nueva nace en Free, sin método de pago. El trigger se apoya en el
-- catálogo ya sembrado arriba; si el plan Free no existiera, el alta falla en
-- vez de dejar la tienda sin suscripción.
CREATE OR REPLACE FUNCTION create_free_subscription_for_store()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  free_plan_id UUID;
BEGIN
  SELECT id INTO free_plan_id FROM plans WHERE lower(code) = 'free' LIMIT 1;
  IF free_plan_id IS NULL THEN
    RAISE EXCEPTION 'plan_free_missing' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO store_subscriptions (
    store_id, plan_id, status, current_period_start, provider
  ) VALUES (
    NEW.id, free_plan_id, 'free', COALESCE(NEW.created_at, NOW()), 'manual'
  )
  ON CONFLICT (store_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stores_create_free_subscription ON stores;
CREATE TRIGGER stores_create_free_subscription
  AFTER INSERT ON stores
  FOR EACH ROW EXECUTE FUNCTION create_free_subscription_for_store();

-- Backfill: todas las tiendas existentes arrancan en Free.
INSERT INTO store_subscriptions (store_id, plan_id, status, current_period_start, provider)
SELECT s.id, p.id, 'free', COALESCE(s.created_at, NOW()), 'manual'
  FROM stores s
  JOIN plans p ON lower(p.code) = 'free'
ON CONFLICT (store_id) DO NOTHING;

-- =============================================================================
--  3. HISTORIAL APPEND-ONLY
-- =============================================================================
CREATE TABLE IF NOT EXISTS subscription_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id   UUID NOT NULL REFERENCES store_subscriptions(id) ON DELETE CASCADE,
  store_id          UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,

  event_type        TEXT NOT NULL CHECK (event_type IN (
                      'subscription_created',
                      'plan_changed',
                      'plan_change_scheduled',
                      'plan_change_applied',
                      'renewal',
                      'cancellation_scheduled',
                      'cancelled',
                      'payment_failed',
                      'payment_recovered',
                      'expired',
                      'promotion_redeemed',
                      'admin_grant',
                      'manual_adjustment'
                    )),

  from_plan_id      UUID REFERENCES plans(id) ON DELETE SET NULL,
  to_plan_id        UUID REFERENCES plans(id) ON DELETE SET NULL,
  status_from       TEXT,
  status_to         TEXT,

  amount_cents      BIGINT CHECK (amount_cents IS NULL OR amount_cents >= 0),
  currency          TEXT CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),

  period_before     TIMESTAMPTZ,
  period_after      TIMESTAMPTZ,

  promotion_id      UUID,
  actor_user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  reason            TEXT,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Clave de idempotencia para renovaciones/webhooks. NULL en eventos que
  -- pueden repetirse legítimamente (p. ej. dos grants manuales).
  idempotency_key   TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_subscription_events_idempotency
  ON subscription_events (idempotency_key);
CREATE INDEX IF NOT EXISTS idx_subscription_events_store
  ON subscription_events (store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscription_events_subscription
  ON subscription_events (subscription_id, created_at DESC);

-- Append-only: los eventos no se editan. DELETE se deja permitido sólo para
-- que el borrado de una tienda (cascade) siga funcionando en staging/QA.
CREATE OR REPLACE FUNCTION prevent_subscription_event_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'subscription_events_append_only' USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS subscription_events_append_only ON subscription_events;
CREATE TRIGGER subscription_events_append_only
  BEFORE UPDATE ON subscription_events
  FOR EACH ROW EXECUTE FUNCTION prevent_subscription_event_update();

-- =============================================================================
--  4. PROMOCIONES Y CANJES
-- =============================================================================
CREATE TABLE IF NOT EXISTS promotions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code             TEXT NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{2,39}$'),
  name             TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  description      TEXT,

  active           BOOLEAN NOT NULL DEFAULT TRUE,
  benefit_type     TEXT NOT NULL DEFAULT 'free_months'
                     CHECK (benefit_type IN ('free_months')),
  duration_months  INTEGER NOT NULL DEFAULT 1 CHECK (duration_months BETWEEN 1 AND 24),
  max_redemptions  INTEGER CHECK (max_redemptions IS NULL OR max_redemptions > 0),

  -- NULL = aplica a cualquier plan de pago. Si se define, la tienda debe
  -- estar YA en ese plan; el código no inventa un upgrade.
  plan_id          UUID REFERENCES plans(id) ON DELETE RESTRICT,

  starts_at        TIMESTAMPTZ,
  ends_at          TIMESTAMPTZ,

  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT promotions_dates_chk
    CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_promotions_code ON promotions (upper(code));
CREATE INDEX IF NOT EXISTS idx_promotions_active_dates
  ON promotions (active, starts_at, ends_at);

DROP TRIGGER IF EXISTS promotions_set_updated_at ON promotions;
CREATE TRIGGER promotions_set_updated_at
  BEFORE UPDATE ON promotions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS promotion_redemptions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id       UUID NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  store_id           UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  subscription_id    UUID NOT NULL REFERENCES store_subscriptions(id) ON DELETE CASCADE,

  redeemed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  period_before      TIMESTAMPTZ,
  period_after       TIMESTAMPTZ NOT NULL,

  granted_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Un código no se puede canjear dos veces por la misma tienda.
  CONSTRAINT promotion_redemptions_one_per_store UNIQUE (promotion_id, store_id)
);

CREATE INDEX IF NOT EXISTS idx_promotion_redemptions_store
  ON promotion_redemptions (store_id, redeemed_at DESC);
CREATE INDEX IF NOT EXISTS idx_promotion_redemptions_promotion
  ON promotion_redemptions (promotion_id, redeemed_at DESC);

-- FK diferida en el historial (se creó antes de promotions para mantener el
-- orden lógico del archivo).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'subscription_events_promotion_fk'
  ) THEN
    ALTER TABLE subscription_events
      ADD CONSTRAINT subscription_events_promotion_fk
      FOREIGN KEY (promotion_id) REFERENCES promotions(id) ON DELETE SET NULL;
  END IF;
END $$;

-- =============================================================================
--  5. VISTA ÚNICA DE CONSUMO DE SKU
-- =============================================================================
CREATE OR REPLACE VIEW store_sku_usage AS
SELECT store_id, COUNT(*)::int AS sku_count
  FROM (
    -- Productos sin variantes activas: cuentan como 1 SKU.
    SELECT sp.store_id
      FROM store_products sp
     WHERE sp.visible = TRUE
       AND sp.archived_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM product_variants v
          WHERE v.store_product_id = sp.id
            AND v.archived_at IS NULL
            AND v.is_active = TRUE
       )

    UNION ALL

    -- Cada variante vendible/publicada cuenta como 1 SKU.
    SELECT v.store_id
      FROM product_variants v
      JOIN store_products sp ON sp.id = v.store_product_id
     WHERE sp.visible = TRUE
       AND sp.archived_at IS NULL
       AND v.archived_at IS NULL
       AND v.is_active = TRUE
  ) sku
 GROUP BY store_id;

COMMENT ON VIEW store_sku_usage IS
  'Consumo de SKU por tienda. Única definición de la regla: producto visible sin variantes activas=1; cada variante activa de producto visible=1; oculto/archivado/inactivo=0.';

COMMIT;
