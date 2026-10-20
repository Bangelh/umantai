# BILLING PROVIDER — estado y camino a cobros reales

## Decisión de esta fase

**Provider implementado: `manual` (test/staging).** No se cobra dinero, no se
usan credenciales live y no se mezcla con Mercado Pago de pedidos.

El contrato está completo en `lib/billing/provider.server.ts`:

```ts
interface BillingProvider {
  createSubscription(input);
  cancelSubscription(input);
  changePlan(input);
  getSubscription(storeId);
  processWebhook(payload);
}
```

`getBillingProvider()` acepta `manual` o `test`. Cualquier otro valor falla
cerrado con `billing_provider_not_implemented` (503): no se simula un cobro real
sin adaptador.

## Por qué NO se reutiliza Mercado Pago Orders

`mp-orders`, `Preferences`, `app/api/payments/*`, tokens y callbacks de pedidos
siguen **congelados**. El cobro recurrente de planes es otro dominio:

- otra entidad (suscripción/preapproval, no una Order de compra);
- otro ciclo (renovación, past_due, cancelación programada);
- otro webhook y otra conciliación;
- otros importes (USD/mes, no el total de un carrito).

Compartir el token o el webhook de pedidos sería un riesgo de negocio y de
auditoría. No se hizo.

## Auditoría de opciones (contexto: Perú, USD, Next.js, staging)

| Opción | Encaje | Estado |
|---|---|---|
| **Manual/test** | Demuestra toda la máquina de estados sin dinero | **Implementado** |
| **Mercado Pago Suscripciones** (`preapproval` / `preapproval_plan`) | API oficial de cobros recurrentes; dominio Perú disponible; medio local conocido por comerciantes | **Candidato principal**, no implementado |
| **Stripe Billing** | Muy completo (prorrateo, portal, invoices), pero hay que validar cuenta/payouts y medios locales | No evaluado en código |
| **Paddle / Lemon Squeezy** | Merchant of record (IVA/facturas), pero payout a Perú y requisitos de cuenta deben validarse | No evaluado en código |
| **Culqi / PSP local** | Puede servir para cargos, pero hay que validar suscripción recurrente real | No evaluado en código |

No se eligió un proveedor definitivo porque es una **decisión de negocio**
(medios de pago, facturación, impuestos, payout, comisiones) que el usuario no
definió. La arquitectura no queda bloqueada: el adaptador es una pieza
intercambiable.

> Mercado Pago documenta la API de Suscripciones (crear preapproval, plan,
> actualizar, pagos autorizados) también bajo el dominio de Perú:
> `https://www.mercadopago.com.pe/developers/...`. Antes de activar hay que
> verificar elegibilidad de la cuenta, moneda y medios disponibles para cada
> comerciante.

## Qué falta exactamente para cobrar de verdad

1. **Decisión de negocio**: proveedor, moneda de cobro, impuestos/comprobantes,
   política de reintentos y de cancelación.
2. **Credenciales sandbox** del proveedor, separadas de las de pedidos. Nunca
   live en esta fase.
3. **Adaptador** que implemente `BillingProvider`:
   - `createSubscription` → crear preapproval/plan y devolver IDs;
   - `cancelSubscription` → cancelar en el proveedor y reflejar
     `cancel_at_period_end`;
   - `changePlan` → definir si el proveedor prorratea o si se agenda;
   - `getSubscription` → mapear estado del proveedor a nuestros 6 estados;
   - `processWebhook` → firma, idempotencia y `subscription_events`.
4. **Webhook propio** de planes (ruta separada de `/api/payments/webhook`),
   con verificación de firma, tolerancia a reintentos y `idempotency_key`.
5. **Mapeo de estados** del proveedor → `free/trialing/active/past_due/
   cancelled/expired`, incluyendo grace period.
6. **Conciliación**: qué pasa si el webhook llega después de la renovación
   manual, cómo se evita doble extensión, cómo se revierte un pago duplicado.
7. **Prorrateo**: el proveedor real decide; no se implementa cobro prorrateado
   manual. En staging el cambio es inmediato.
8. **Comprobantes/impuestos** y textos legales de la suscripción.
9. **Pruebas E2E sandbox**: upgrade, downgrade, cancelación, fallo, renovación,
   reembolso y webhook duplicado.
10. **Runbook** de incidentes: cobro duplicado, past_due, cancelación pedida por
    el comerciante, disputa.

## Variables de entorno

| Variable | Uso | Default |
|---|---|---|
| `BILLING_PROVIDER` | `manual`/`test`; otro valor falla cerrado | `manual` |
| `BILLING_GRACE_DAYS` | Días de gracia de `past_due` antes de expirar | `3` |
| `CRON_SECRET` | Autoriza `/api/cron/billing` | requerido fuera de dev |

Las credenciales reales (access token, webhook secret, plan IDs) **no existen**
en staging y no deben agregarse hasta cerrar la decisión de negocio.

## Estado verificable hoy

- Free/Starter/Growth y límites 25/50/100.
- Upgrade, downgrade programado, cancelación, renovación idempotente, past_due,
  expiración.
- Promociones +1 mes, duplicados, vencimiento, máximo, plan equivocado y grant
  admin.
- Historial append-only y auditoría de Platform Admin.
- Todo demostrable con `manual` sin cargos reales.
