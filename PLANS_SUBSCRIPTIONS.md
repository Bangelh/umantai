# PLANS + SUBSCRIPTIONS + PROMOTIONS

Estado: **implementado en staging, provider manual/test**. No hay cobros reales.

Este documento fija las decisiones de la fase y dónde vive cada regla. El código
de Mercado Pago de **pedidos** (`mp-orders`, Preferences, webhook de pedidos)
permanece congelado y no se reutiliza para suscripciones SaaS.

---

## 1. Catálogo de planes

Fuente única: `plans` (migración `017_plans_subscriptions.sql`) y
`lib/billing.ts` (`PLAN_DEFINITIONS`, sólo para tests/docs/UI).

| code | name | price_cents | currency | interval | sku_limit |
|---|---|---:|---|---|---:|
| `free` | Free | 0 | USD | month | 25 |
| `starter` | Starter | 400 | USD | month | 50 |
| `growth` | Growth | 600 | USD | month | 100 |

No hay conversión PEN/USD automática en esta fase. El precio comercial se
muestra en USD y el cobro real queda pendiente del proveedor.

## 2. Qué cuenta como SKU

La única definición vive en la vista `store_sku_usage`:

- producto **visible**, no archivado y sin variantes activas → **1 SKU**;
- cada **variante activa y no archivada** de un producto visible → **1 SKU**;
- producto oculto/draft, producto archivado, variante inactiva o archivada → **0**;
- no se cuentan filas de `store_products` a ciegas.

`lib/billing/sku.server.ts` es el único enforcement de aplicación. La vista y
el servicio se usan en la UI, el admin, el seed y los tests.

### Enforcement

Se valida antes de:

- publicar un producto (`visible false → true`);
- crear un producto visible;
- crear/activar una variante publicada;
- (el endpoint de duplicar producto no existe en esta fase; la utilidad central
  queda lista para cuando se implemente).

El límite exacto se permite. Límite + 1 devuelve:

```json
{
  "error": "Tu plan free permite 25 SKU…",
  "code": "plan_sku_limit_reached",
  "plan": "free",
  "limit": 25,
  "current": 25,
  "requested": 1
}
```

HTTP `409`. El producto rechazado no se escribe.

### Over limit

Al bajar de plan (o al renovar un downgrade programado) no se despublica nada.
Si `usage > plan.sku_limit`:

- `store_subscriptions.over_limit_at` queda marcado;
- los productos ya publicados siguen visibles;
- se bloquean nuevas publicaciones/activaciones hasta archivar/despublicar o
  mejorar de plan;
- archivar/despublicar reduce el uso y limpia el estado.

La decisión es deliberada: no se rompe la vitrina de un comerciante por un
cambio de plan.

## 3. Suscripción por tienda

Modelo `store_subscriptions`, una fila por tienda (`UNIQUE store_id`):

- `plan_id`, `status`, `current_period_start/end`;
- `cancel_at_period_end`, `cancelled_at`;
- `provider`, `provider_customer_id`, `provider_subscription_id`;
- `pending_plan_id` + `pending_plan_effective_at` para downgrade programado;
- `over_limit_at`.

Estados permitidos:

`free`, `trialing`, `active`, `past_due`, `cancelled`, `expired`.

Transiciones implementadas:

- **Alta**: trigger `stores_create_free_subscription` crea Free explícito.
  Free nunca se representa con `plan_id = NULL`.
- **Upgrade** (`free → starter`, `starter → growth`): inmediato en provider
  manual, `active`, período de 1 mes si venía de Free.
- **Downgrade**: `changeStorePlan(..., effective='period_end')` guarda
  `pending_plan_id`; la renovación aplica el plan y deja `over_limit` si excede.
  El admin puede aplicarlo inmediato en staging.
- **Cancelación**: por defecto `cancel_at_period_end = true` y
  `status = cancelled`; conserva el plan y los beneficios hasta el final. El
  cron pasa a Free.
- **Renovación**: job idempotente; extiende un período, aplica pendiente y deja
  evento. Una segunda ejecución no extiende.
- **Fallo de pago**: `active → past_due`; no desactiva la tienda. Después de
  `BILLING_GRACE_DAYS` (default 3) el cron pasa a Free y deja evento `expired`.
- `trialing` y `expired` están en el enum para el proveedor real/histórico; la
  primera versión no crea trials automáticos.

## 4. Historial

`subscription_events` es append-only (trigger bloquea UPDATE). Tipos:

`subscription_created`, `plan_changed`, `plan_change_scheduled`,
`plan_change_applied`, `renewal`, `cancellation_scheduled`, `cancelled`,
`payment_failed`, `payment_recovered`, `expired`, `promotion_redeemed`,
`admin_grant`, `manual_adjustment`.

Cada evento guarda plan/status anterior y nuevo, período, actor, razón,
metadata y `idempotency_key` cuando aplica. El historial se consulta en
`GET /api/admin/billing/subscriptions/:storeId/history`.

## 5. Meses gratis

Tablas `promotions` + `promotion_redemptions`:

- `code` único case-insensitive;
- `benefit_type = free_months`, `duration_months` 1–24;
- `max_redemptions` opcional;
- `plan_id` opcional: si existe, la tienda debe estar **ya** en ese plan;
- `starts_at`/`ends_at` opcionales;
- único `(promotion_id, store_id)` para impedir doble canje;
- el período se extiende con `GREATEST(current_period_end, NOW()) + N meses`.

**Regla de Free**: un código no convierte Free en plan pago. Se devuelve
`promotion_requires_paid_plan`. Tampoco se inventa un trial. El comerciante
primero elige Starter/Growth; después canjea.

El grant manual de Platform Admin (`grant-month`) hace lo mismo sin código y
deja evento `admin_grant`. No permite aplicarlo a Free.

## 6. API y UI

### Comerciante (owner/admin de ESA tienda)

- `GET /api/merchant/stores/:storeId/billing`
- `POST /api/merchant/stores/:storeId/billing/change-plan`
- `POST /api/merchant/stores/:storeId/billing/cancel`
- `POST /api/merchant/stores/:storeId/billing/redeem`

UI: sección **“Plan y facturación”** dentro de `/negocio/<storeId>`:
plan, precio, estado, `18 / 25 SKU utilizados`, barra, renovación, upgrade,
downgrade programado, cancelación y código promocional.

### Platform Admin

- `GET /api/admin/plans`
- `GET /api/admin/billing/subscriptions`
- `POST /api/admin/billing/subscriptions/:storeId/change-plan`
- `POST /api/admin/billing/subscriptions/:storeId/grant-month`
- `GET /api/admin/billing/subscriptions/:storeId/history`
- `POST /api/admin/billing/subscriptions/:storeId/simulate-payment-failure`
- `GET/POST /api/admin/promotions`
- `PATCH /api/admin/promotions/:promotionId`

UI: `/admin/planes`, protegida por `ADMIN_API_SECRET` (`x-admin-token`).
No comparte sesión ni permisos con Store Admin.

### Tenancy

El `storeId` de la URL no se confía: `requireStoreAccess(userId, storeId,
'admin')` corre antes de leer o cambiar billing. Un merchant de B no puede leer
ni operar el billing de A. Hay tests explícitos.

## 7. Search / discovery

Política centralizada: **el estado de facturación nunca oculta una tienda por sí
solo**. Una tienda `active` + `approved` sigue apareciendo si está Free,
`over_limit` o `past_due` dentro de la gracia. La visibilidad pública sigue
dependiendo de `stores.active` (y del catálogo publicado), no de `over_limit`.
No hay cobranza agresiva ni despublicación automática.

## 8. Cron

Endpoint: `GET /api/cron/billing`, protegido por `CRON_SECRET` (o admin token
manual en dev). Script portable: `scripts/trigger-billing.mjs`.

Es **conceptualmente separado** de `/api/cron/expire-reservations` (pedidos). Se
recomienda un segundo servicio cron con schedule horario. El job:

- renueva suscripciones manuales vencidas;
- aplica cancelaciones al final del período;
- expira `past_due` después de la gracia;
- usa `FOR UPDATE`, condiciones de período y `idempotency_key` única;
- no toca pedidos, stock, Mercado Pago ni `stores.active`.

## 9. Seed de staging

`scripts/seed-platform.ts` deja:

| Tienda | Plan | SKU aproximados |
|---|---|---:|
| Bodega La Esquina | Free | 6 |
| Hilos & Estilo | Starter | 8 |
| Telas del Sur | Growth | 7 |
| Ferretería Central | Starter + promo `FERIA1M` | 4 |

El seed es idempotente y usa el mismo camino de cambio de plan (deja historial).

## 10. Límites y deuda

- El provider real no está implementado; ver `BILLING_PROVIDER.md`.
- No hay prorrateo manual. En provider manual el cambio es inmediato; el
  contrato deja `effective` para que el proveedor real decida.
- El enforcement de SKU es de aplicación (pre-chequeo); no hay trigger de DB que
  cierre una carrera entre dos publicaciones simultáneas. Es una mejora futura
  recomendada si el volumen lo exige.
- Los planes no se editan desde la UI; se cambian por migración. El admin puede
  verlos y el catálogo está modelado para futuras ediciones.
- No se implementó “duplicar producto” porque esa función no existe en esta
  fase. La regla central puede reutilizarse cuando se agregue.
