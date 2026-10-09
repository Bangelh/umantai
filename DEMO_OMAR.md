# DEMO_OMAR.md — Runbook de la demo UMANTAI (Preview)

> Operativo. 5–7 minutos. **Solo Preview.** Nada de Producción, nada de `main`.
> Sin secretos, sin tokens, sin `public_token`, sin PINs históricos en este archivo.

---

## 1. Objetivo de la demo

Mostrar el ciclo completo de negocio funcionando **de punta a punta** en Preview:

```
catálogo → pedido → pago → preparado → PIN en la página del pedido
        → retiro en el kiosco → picked_up → inventario consolidado
```

Mensaje que Omar debe llevarse: **el circuito de venta funciona completo y el stock se descuenta solo**.

---

## 2. Precondiciones (verificar ANTES de que llegue Omar)

| # | Precondición | Cómo se verifica |
|---|---|---|
| 1 | Branch y deploy correctos | `feat/payment-simulation-qa` @ `73b19c7` |
| 2 | Simulador QA ENCENDIDO | `POST /api/admin/qa/simulate-payment` responde **403** (gate abierto, falta token) y **no** 404 |
| 3 | Kiosco CONFIGURADO | `GET /api/kiosk/queue` responde **401** (clave presente) y **no** 503 |
| 4 | Stock del SKU de demo | `dyson-v15-detect` debe quedar en **onHand 5 · reserved 4 · available 1** → ver §4 |
| 5 | Credenciales del operador en la mano | `ADMIN_API_SECRET` y `KIOSK_ACCESS_CODE` (nunca en pantalla) |

### Placeholders usados (nunca valores reales)

```bash
BASE="https://umantai-git-feat-payment-simulation-qa-umantai.vercel.app"
# en bash:      $ADMIN_API_SECRET   $KIOSK_ACCESS_CODE
# en PowerShell: $env:ADMIN_API_SECRET   $env:KIOSK_ACCESS_CODE
```

---

## 3. URL Preview

| Qué | URL |
|---|---|
| Tienda (cliente) | `https://umantai-git-feat-payment-simulation-qa-umantai.vercel.app/` |
| Panel del kiosco (operaria) | `…/admin/kiosco` |
| Inventario | `…/admin/inventario` |
| Pedido del cliente | `…/pedido/<token-del-pedido>` |

---

## 4. Preparar el stock (UNA vez, antes de la demo)

**Estado de referencia:** el Preview solo tiene fila de inventario para `dyson-v15-detect`
(hoy `on_hand 4 · reserved 4 · available 0`). El objetivo es dejarlo en **`5 / 4 / 1`**: exactamente
una unidad disponible para una corrida.

### a) Reportar el estado actual

```bash
curl -s -H "x-admin-token: $ADMIN_API_SECRET" "$BASE/api/admin/inventory"
```

### b) UNA sola recepción de +1 (flujo normal de inventory receipt, sin retry)

`dyson-v15-detect` no tiene variantes, así que su `variantKey` es `""` (se puede omitir).

```bash
curl -s -X POST "$BASE/api/admin/inventory" \
  -H "x-admin-token: $ADMIN_API_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"productSlug":"dyson-v15-detect","quantity":1,"reason":"demo prep"}'
```

### c) Verificar (read-only)

```bash
curl -s -H "x-admin-token: $ADMIN_API_SECRET" "$BASE/api/admin/inventory" \
  | python -c "import json,sys; d=json.load(sys.stdin); [print(i) for i in d['items'] if i['productSlug']=='dyson-v15-detect']"
```

Esperado exacto: **`quantityOnHand 5` · `quantityReserved 4` · `quantityAvailable 1`**.

> ⚠️ Si no queda exactamente `5 / 4 / 1`: **DETENERSE**. **No** hacer una segunda escritura.
> No se toca `reserved`, no se liberan reservas, no se ajustan pedidos históricos, no se toca otro SKU.

> ⚠️ **Una unidad = una corrida.** Al retirar, el pedido devuelve `dyson` a `4 / 4 / 0`.
> Si vas a repetir la demo, necesitas **otra** recepción de `+1` antes de la segunda pasada.

---

## 5. Checklist de la demo (5–7 minutos)

| # | Paso | Acción | Resultado esperado |
|---|---|---|---|
| A | Crear pedido | Tienda → agregar **Dyson V15 Detect Absolute** → checkout con email, tipo de entrega **pickup** | Pedido creado (201) y redirección a `/pedido/<token>` |
| B | Pedido sin pagar | Mirar la página del pedido | **“Awaiting payment”** (reserva válida ~30 min) |
| C | Simular el pago | Comando de §6 (una sola llamada) | `ok: true`, `applied: true`, `source: "simulation"` |
| D | Pedido pagado | Recargar `/pedido/<token>` | **“Payment confirmed”** + badge **“Pago simulado — QA”** |
| E | Abrir kiosco | `…/admin/kiosco` → introducir `KIOSK_ACCESS_CODE` | Tablero con los dos tabs (Entregar / Preparar) |
| F | Marcar listo | Tab **“preparar”** → tarjeta del pedido → **“YA ESTÁ EN EL CASILLERO”** | Aviso de émisión de PIN + aviso al cliente por correo |
| G | Leer el PIN | `/pedido/<token>` | Bloque **“YOUR PICKUP CODE”** con 6 dígitos y su vencimiento |
| H | Entregar | Kiosco → tab **“entregar”** → tipear el PIN | Confirmación de entrega (**el kiosco nunca muestra el PIN**) |
| I | Pedido retirado | `/pedido/<token>` | **“Picked up”**, sin bloque de PIN |
| J | Inventario | `…/admin/inventario` | `dyson` baja a `on_hand 4 · reserved 4 · available 0` |

---

## 6. Endpoints exactos (una llamada cada uno, sin retry)

### A — Simular el pago (`POST /api/admin/qa/simulate-payment`)

Necesita `x-admin-token`. **Este es el único paso que requiere `ADMIN_API_SECRET`.**

```bash
curl -s -X POST "$BASE/api/admin/qa/simulate-payment" \
  -H "x-admin-token: $ADMIN_API_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"orderId":"<ORDER_ID>"}'
```

- Body: **solo** `orderId`. El monto y el resultado los lee el servidor del pedido real.
- Esperado: `"status":"confirmed"`, `"paymentStatus":"paid"`, `"source":"simulation"`, `"applied":true`.
- Si `"applied": false` con `"idempotentReason":"already_applied"` → ya se simuló; **correcto**, no repetir.

### B — Marcar listo / emitir PIN (`POST /api/kiosk/ready`)

Necesita `x-kiosk-access`. Desde la UI es el botón **“YA ESTÁ EN EL CASILLERO”**; por CLI:

```bash
curl -s -X POST "$BASE/api/kiosk/ready" \
  -H "x-kiosk-access: $KIOSK_ACCESS_CODE" \
  -H "x-kiosk-device: kiosco-demo" \
  -H 'Content-Type: application/json' \
  -d '{"orderId":"<ORDER_ID>"}'
```

- Body: `orderId` (obligatorio), `lockerCode` / `lockerSlot` (opcionales).
- **El PIN no se devuelve acá**: se lee en `/pedido/<token>` (§7).
- Esperado: `ok: true`, `codeExpiresAt`, `customerNotification`.

### C — Retirar (`POST /api/kiosk/pickup`)

Necesita `x-kiosk-access`. Desde la UI es el tab **“entregar”**.

```bash
curl -s -X POST "$BASE/api/kiosk/pickup" \
  -H "x-kiosk-access: $KIOSK_ACCESS_CODE" \
  -H "x-kiosk-device: kiosco-demo" \
  -H 'Content-Type: application/json' \
  -d '{"code":"<PIN_DE_6_DIGITOS>"}'
```

- **Una sola llamada.** Si falla, no reintentar en bucle.
- Un PIN rechazado es un resultado de negocio (HTTP 200 con `ok:false`); `429` = freno por intentos.
- Esperado: `ok: true`, `orderNumber`, `committedLines: 1`.

### D — Verificar inventario (`GET /api/admin/inventory`)

```bash
curl -s -H "x-admin-token: $ADMIN_API_SECRET" "$BASE/api/admin/inventory"
```

Panel equivalente: `…/admin/inventario`.

---

## 7. Dónde leer el PIN

**Solo** en la página del pedido del cliente: `/pedido/<token>` → bloque **“YOUR PICKUP CODE”**
(6 dígitos, con hora de vencimiento). El kiosco **nunca** devuelve ni muestra el PIN: lo dicta el
cliente y lo tipea la operaria.

### Cómo localizar el `orderId` sin exponer el `public_token`

El `public_token` es el identificador público del pedido y **no debe dictarse ni compartirse**.
Para obtener el `orderId` (UUID interno) basta con:

- **DevTools → Network**, llamada `orders` (POST), pestaña **Response** → `order.id`.

Para el paso F **no hace falta el `orderId`**: el kiosco lista el pedido pagado y el botón
**“YA ESTÁ EN EL CASILLERO”** ya lo manda. El `orderId` solo se necesita si se usa el comando CLI del §6-A.

---

## 8. Mensajes para Omar sobre Mercado Pago

Decir, en este orden:

1. **“La Orders API real de Mercado Pago ya funciona: crea la orden y devuelve su `checkout_url`.”**
2. **“El bloqueo que tenemos hoy es del checkout *hospedado* de Mercado Pago en sandbox, no de nuestra integración.”**
3. **“Para que la demo no dependa de eso, reemplazamos SOLO el paso de aprobación del pago por una simulación interna que corre con el mismo código que usa el webhook real.”**
4. **“La simulación está habilitada únicamente en Preview. En Producción no existe: la ruta queda cerrada por diseño.”**
5. **“Nada de esto llega a Producción ni cobra dinero real.”**

---

## 9. Qué NO mostrar

- La barra de direcciones con el `public_token` del pedido (ni dictarlo).
- Secretos: `ADMIN_API_SECRET`, `KIOSK_ACCESS_CODE`, access tokens de Mercado Pago.
- El error / la pantalla del checkout sandbox de Mercado Pago.
- `main`, Producción ni ningún deploy de Producción.
- `/api/debug/env` ni paneles de diagnóstico.
- La terminal con variables de entorno exportadas.
- PINs o tokens de pedidos históricos (los de QA que ya existen).

---

## 10. Plan de recuperación

### Si `simulate-payment` falla

1. **No improvisar.** No tocar la base, no editar `orders`, no reintentar en bucle.
2. Revisar los **tres candados**: `VERCEL_ENV === "preview"` **y** `MP_PAYMENT_SIMULATION === "1"` **y** `x-admin-token` válido.
3. Si responde **404**: entorno o flag apagados (no es Preview o el flag se cayó).
4. Si responde **403**: la autenticación administrativa falla → el `ADMIN_API_SECRET` usado no es el de Preview.
5. Si responde **500**: no hay más reintentos; se sigue con un pedido ya confirmado o se suspende ese paso de la demo.

### Si `ready` falla

1. Verificar `paymentStatus` del pedido (**debe ser `paid`**) y `metadata.payment.needsReview` (**debe ser `false`**).
2. Verificar que el `KIOSK_ACCESS_CODE` es el correcto (si el kiosco responde 503, la clave no está configurada; 401, es incorrecta).
3. Códigos esperados: `order_not_paid`, `invalid_order_transition`, `order_requires_review` → el pedido no se puede preparar; **no forzarlo**.

### Si `pickup` falla

1. Verificar que el PIN es el **vigente** (el que muestra `/pedido/<token>` ahora) y que **no fue consumido**.
2. Códigos esperados: `pickup_code_expired`, `pickup_code_locked`, `pickup_code_already_used` (este último significa que el pedido **ya se entregó**: no entregar nada).
3. **No repetir varias veces**: hay freno por intentos (429). Un PIN bloqueado requiere emitir uno nuevo.

### Si Omar pregunta por Mercado Pago

Responder con §8 punto por punto: la integración real crea órdenes y devuelve `checkout_url`;
el bloqueo es del sandbox hospedado de MP; la simulación reemplaza **solo la aprobación del pago**;
y Producción no permite simulación.

---

## 11. Reglas de la demo

- **Solo Preview.** No Producción. No `main`. No merge. No deploy de Producción.
- **Sin cambios de código** durante la demo.
- Una sola escritura de inventario preparatoria (§4b) y **una sola** llamada por paso del flujo.
- Si algo no cuadra: **detenerse y reportarlo**, no forzar el estado.
