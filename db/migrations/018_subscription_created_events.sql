-- =============================================================================
-- 018_subscription_created_events.sql — historial de inicio de suscripción
-- =============================================================================
-- 017 dejó la fila Free, pero no registraba el evento de inicio. Esta migración:
--   · hace que el trigger de alta escriba `subscription_created`;
--   · rellena el evento para las suscripciones ya existentes.
--
-- No toca planes, precios, límites ni Mercado Pago de pedidos.
-- IDEMPOTENTE: el backfill usa NOT EXISTS y el trigger sólo inserta en altas.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION create_free_subscription_for_store()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  free_plan_id UUID;
  subscription_id UUID;
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
  ON CONFLICT (store_id) DO NOTHING
  RETURNING id INTO subscription_id;

  IF subscription_id IS NOT NULL THEN
    INSERT INTO subscription_events (
      subscription_id, store_id, event_type, to_plan_id, status_to, metadata
    ) VALUES (
      subscription_id, NEW.id, 'subscription_created', free_plan_id, 'free',
      '{"source":"store_created"}'::jsonb
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stores_create_free_subscription ON stores;
CREATE TRIGGER stores_create_free_subscription
  AFTER INSERT ON stores
  FOR EACH ROW EXECUTE FUNCTION create_free_subscription_for_store();

-- Backfill de inicio para suscripciones anteriores a esta migración.
INSERT INTO subscription_events (
  subscription_id, store_id, event_type, to_plan_id, status_to, metadata, created_at
)
SELECT ss.id, ss.store_id, 'subscription_created', ss.plan_id, ss.status,
       '{"source":"migration_backfill"}'::jsonb,
       COALESCE(ss.created_at, NOW())
  FROM store_subscriptions ss
 WHERE NOT EXISTS (
   SELECT 1 FROM subscription_events e
    WHERE e.subscription_id = ss.id
      AND e.event_type = 'subscription_created'
 );

COMMIT;
