# Mercado Pago Orders (experimento QA) — ESTADO CONGELADO

**Fecha:** 2026-10-15
**Estado:** 🔒 **CONGELADO** — esperando respuesta de soporte de Mercado Pago.
**Alcance:** el experimento aislado de Checkout Pro vía Orders API (`/api/mp-orders/*`,
`/api/admin/qa/mp-orders/*`). La tienda sigue funcionando con el flujo de siempre
(Preferences + webhook propio): **nada de esto lo toca**.

---

## 1. Dónde está el bloqueo (exactamente)

El **checkout HOSPEDADO de Mercado Pago falla antes de mostrar el login del
comprador** y redirige a:

```
/checkout/v1/payment/redirect/exception
```

- **Código visible del último intento:** `COW00-W6GQPYJPOVPZ`
- **Ticket abierto con soporte de Mercado Pago** con toda la evidencia de la sección 2.
- **No es corregible desde nuestro lado** con la evidencia disponible: nuestro tramo
  (crear la Order, leerla, configurar las URLs de retorno y usar el comprador de prueba
  real) responde correctamente y sin errores. El fallo ocurre **después** de la lectura
  200, dentro del checkout hospedado, en un tramo que no controlamos.

---

## 2. Evidencia recogida (verificada, sin secretos)

| Comprobación | Resultado |
|---|---|
| `POST /v1/orders` | **201** (segunda Order de diagnóstico creada) |
| `GET /v1/orders/{id}` | **200** |
| `status` | `created` |
| `countryCode` / `currency` | `PER` / `PEN` |
| `processingMode` | `manual` |
| `errors` | `null` |
| `checkoutUrlExists` | `true` |
| `config.online.success_url` / `pending_url` / `failure_url` | apuntan al **Preview correcto** de este repositorio |
| `config.online.auto_return` | `approved` |
| `payer.email` | cuenta de prueba **comprador real** (sale de `MP_ORDERS_QA_PAYER_EMAIL`; nunca un placeholder inventado) |
| Modo de la Order | PRUEBA (`live_mode: false`) |

La lectura se hizo con `GET /api/admin/qa/mp-orders/[orderId]` (herramienta QA
read-only, ver sección 4), que devuelve esa vista **sanitizada**: sin el `checkout_url`
completo, sin el email completo del comprador, sin tokens ni secretos.

**Conclusión:** la creación, la lectura y la configuración de la Order son correctas.
El bloqueo está en el checkout hospedado de Mercado Pago, delante del login del
comprador.

---

## 3. Qué queda CONGELADO (no hacer hasta nueva autorización)

- ❌ Nuevas Orders de diagnóstico.
- ❌ Cambios de payload (`minimal` / `documented`).
- ❌ Pruebas en modo `documented` ni ninguna otra variante de payload.
- ❌ Cambios de credenciales (access token, secrets, cuentas de prueba).
- ❌ Cambios de webhook (ni el legacy ni el de Orders).
- ❌ Cambios en Preferences.
- ❌ Cambios en Producción.
- ❌ Más experimentos con Checkout Pro.
- ❌ Migración a Railway.

**Pendientes que NO se desarrollan todavía** (esperan autorización explícita):

- El adaptador **`Orders` → `applyApprovedPayment()`**.
- El reemplazo del flujo de Preferences por Orders en la tienda.

---

## 4. Qué queda disponible (Preview, solo lectura o QA)

| Ruta | Para qué |
|---|---|
| `GET /api/admin/qa/mp-orders/[orderId]` | Inspeccionar UNA Order existente (read-only, respuesta sanitizada). Requiere `x-admin-token`; 404 en Producción; 503 sin `MP_ORDERS_ACCESS_TOKEN`. |
| `POST /api/mp-orders/create` | Crear una Order QA (congelado: no ejecutar). |
| `POST /api/mp-orders/webhook` | Receptor del tópico `order` (valida firma con el secret de Orders). |
| `GET /api/mp-orders/debug` | Diagnóstico de presencia de variables `MP_ORDERS_*` (solo booleanos). |
| `POST /api/admin/qa/simulate-payment` | Flujo interno completo **sin** depender del checkout hospedado (ver `QA_PAYMENT_SIMULATION.md`). |

Variables de entorno: ver la sección «Mercado Pago Orders API (experimento QA — NO
productivo)» de `ENVIRONMENT_VARIABLES.md`.

---

## 5. Estado del repositorio y del despliegue

- Commit `fa25dcd` — *feat(qa): inspeccionar una Order de Mercado Pago sin exponer
  credenciales* — pusheado a `feat/payment-simulation-qa`. Árbol sin cambios pendientes.
- Vercel reconstruyó el Preview de ese commit en sus 6 proyectos: **5 `success`** y
  `umantai-dh4a` en `failure`. Esa falla es **preexistente**: `umantai-dh4a` falla al
  instante y ya fallaba igual en el commit anterior `694c159`, mientras los otros 5
  construían bien — no es consecuencia de este push.
- Producción, Preferences, webhooks y credenciales: **sin cambios**.

---

## 6. Próximo paso

Esperar la respuesta de soporte de Mercado Pago. Cuando llegue, retomar **solo** el
diagnóstico del checkout hospedado; cualquier trabajo de adaptador o de reemplazo de
Preferences requiere autorización nueva.
