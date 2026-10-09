# Simulación de pago QA (solo Preview)

Herramienta de QA para demostrar el flujo interno completo **sin** depender de la
página hospedada de Mercado Pago en sandbox. **No es un pago real** y **no puede
usarse en Producción**.

> El checkout de Mercado Pago (sandbox) puede fallar por un problema de su lado
> (ticket de soporte abierto). Esta herramienta permite demostrar el flujo interno
> igual, ejecutando **el mismo** camino que un webhook legítimo.

## Arquitectura

```
WEBHOOK REAL                          SIMULADOR (Preview)
────────────                          ───────────────────
firma HMAC                            gate QA (3 candados)
leer el pago de Mercado Pago  ──┐     (se salta MP a propósito)
pago aprobado                    │
                                 ▼
                        applyApprovedPayment()   ← MISMA función interna
                                 │
                    confirmed / stock / notificaciones
```

- `confirm_order_payment()` (PL/pgSQL) sigue siendo la autoridad: es atómica e
  idempotente. La simulación **no** hace `UPDATE` directo de `orders`.
- El pago simulado se identifica con `SIMULATED-MP-<orderId>`, que **nunca** puede
  confundirse con un Payment ID real (los reales son numéricos).
- `orders.metadata.payment.source = "simulation"` marca el origen, sin migraciones
  de esquema.

## Gate (fail-closed)

Deben estar abiertos los tres candados A LA VEZ:

1. `VERCEL_ENV === "preview"`
2. `MP_PAYMENT_SIMULATION === "1"`
3. autenticación administrativa (`x-admin-token` = `ADMIN_API_SECRET`)

Si falla el entorno o el flag → **404**. Si falla la autenticación administrativa →
**403**. No hay fallback, ni enable por querystring/body, ni forma de habilitarlo en
Producción.

## Activar en Preview

En Vercel → Project → Settings → Environment Variables, **solo** en el entorno
**Preview** (nunca Production):

```
MP_PAYMENT_SIMULATION = 1
```

Vuelve a desplegar el Preview para que la variable llegue al runtime.

## Ejecutar una simulación

```bash
# 1. Reemplaza los valores por los de tu Preview.
PREVIEW_URL="https://<tu-preview>.vercel.app"
ADMIN_TOKEN="<ADMIN_API_SECRET de ese entorno>"
ORDER_ID="<uuid interno del pedido>"

# 2. Simula el pago aprobado. ÚNICO dato: orderId.
curl -sS -X POST "$PREVIEW_URL/api/admin/qa/simulate-payment" \
  -H "content-type: application/json" \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -d "{\"orderId\":\"$ORDER_ID\"}"
```

Respuesta (200):

```json
{
  "ok": true,
  "order": {
    "id": "…",
    "orderNumber": "…",
    "previousStatus": "pending_payment",
    "status": "confirmed",
    "previousPaymentStatus": "pending",
    "paymentStatus": "paid"
  },
  "simulationId": "SIMULATED-MP-…",
  "applied": true,
  "idempotentReason": null,
  "fulfillmentBlocked": false,
  "storeNotified": true,
  "source": "simulation"
}
```

Ejecutarlo otra vez con el mismo `orderId` es idempotente: `applied: false`,
`idempotentReason: "already_applied"`, mismo estado. No reconfirma, no descuenta
stock dos veces, no reenvía el PIN.

## Flujo demostrable a Omar

```
crear pedido (POST /api/orders)
  → simular pago (POST /api/admin/qa/simulate-payment)   → confirmed / paid
  → preparar (POST /api/kiosk/ready)                      → ready_for_pickup + PIN
  → PIN visible en /pedido/<token>
  → retirar (POST /api/kiosk/pickup con el PIN)           → picked_up + commit de inventario
  → stock final en /admin/inventario
```

## Conflictos

Si el pago simulado no puede retener stock (`needsReview`/`stockConflict`), el
pedido queda igualmente `confirmed`/`paid` (verdad económica), con
`fulfillmentBlocked: true`, y las guardas existentes (migración 006) rechazan
`ready`/`pickup` con `order_requires_review` hasta revisión humana.
