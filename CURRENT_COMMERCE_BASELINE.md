# CURRENT COMMERCE BASELINE (auditoría previa — 2026-10-19)

Alcance: cómo funciona HOY el comercio en `feat/railway-staging` antes de la
Fase Funcional 1. Sin cambios de código en este documento.

## 1. Carrito

- `lib/cartStore.ts` (Zustand + `persist` en `localStorage`, clave `umantai-cart`).
- Línea = `slug + variant_key` (`cartLineKey`); un producto puede repetirse con
  distintas variantes. Carritos viejos con `selectedColor/selectedStorage` se
  normalizan vía `cartItemVariant`.
- El precio que muestra el carrito sale del catálogo (`Product.price`), **no** es
  autoridad: el servidor lo recalcula.
- Cantidad mínima 1; no hay tope en el cliente (el servidor limita a 99 por línea).
- No hay paso de confirmación: el botón “Proceed to Checkout” crea el pedido y
  redirige al pago.

## 2. Creación de pedido

`POST /api/orders` (`app/api/orders/route.ts`):

1. Exige `contactEmail` válido, `fulfillmentType` y líneas no vacías.
2. Resuelve producto/variante/precio contra `baseProductsData` + overrides de
   `/admin` (nunca confía en el precio del navegador).
3. `variantKeyForSelection()` valida la combinación exacta de opciones.
4. Ejecuta `expireStaleOrders()` como limpieza perezosa antes de reservar.
5. Llama `createOrder()` (`lib/commerce.server.ts`), que inserta `orders` +
   `order_items` + `inventory_reserve_order()` en **una transacción**.
6. Responde 201 con el pedido; 409 con `code: 'insufficient_stock'` si no hay
   stock; 400 por validación.

Idempotencia: `orders.idempotency_key` único. `createOrder` devuelve el pedido
existente si la clave ya se usó (incluida la carrera por violación única). El
carrito genera una clave por intento y la reutiliza mientras el carrito no cambie.

## 3. Reserva de stock

- `inventory_reserve_order(order_id)` recorre las líneas y llama
  `inventory_apply_movement(..., 'reservation', reserved_delta = quantity)`.
- `inventory_apply_movement` es la única puerta: inserta/crea la fila de
  inventario, hace un `UPDATE` condicional con row lock y exige
  `on_hand >= 0` y `on_hand - reserved >= 0`; si no, lanza `insufficient_stock`.
- Inserta el movimiento en `inventory_movements` con saldos resultantes
  (`on_hand_after`, `reserved_after`), `reason`, `performed_by` y clave de
  idempotencia.
- `quantity_available` es columna generada (`on_hand - reserved`).
- TTL de reserva: 30 min (`COMMERCE_RESERVATION_TTL_MINUTES`).

## 4. Cancelación / liberación

- `cancelOrder()` revoca PINs vigentes, llama `inventory_release_order()` y
  transiciona a `cancelled` en una transacción.
- `inventory_release_order` (migración 007) no devuelve al stock líneas que ya
  fueron re-reservadas por un pago tardío (`prior_releases`).
- `expire_stale_orders()` hace lo mismo para reservas vencidas; se invoca en
  creación de pedido, cron y lectura de la página del pedido.

## 5. Inventario y movimientos

- Tabla `inventory` por `(location_code, product_slug, variant_key)`:
  `quantity_on_hand`, `quantity_reserved`, `quantity_available` (generada),
  `reorder_point`, `is_active`.
- `inventory_movements`: ledger append-only con delta de físico/reservado,
  saldos resultantes, pedido/línea, motivo, actor, idempotencia y timestamp.
  Nunca se actualiza stock sin insertar movimiento.
- Tipos: `receipt`, `reservation`, `reservation_release`, `sale`, `adjustment`,
  `recount`, `return`, `shrinkage`, `transfer_in`, `transfer_out`.

## 6. Admin de inventario (estado actual)

- `GET /api/admin/inventory` → lista completa + `lowStock`
  (`reorder_point > 0 AND available <= reorder_point`).
- `POST /api/admin/inventory` → **solo ingreso** (`receipt`) + punto de reorden.
- `GET /api/admin/inventory/movements?product=` → auditoría de reconciliación de
  un SKU (no es un listado global filtrable).
- `GET /api/admin/inventory/receipt-plan` → plan read-only de reposición.
- UI `app/admin/inventario/page.tsx`: login por token, tabla básica, alertas y
  formulario de ingreso. **No hay** buscador, filtros, estados visuales,
  ajustes positivos/negativos ni historial global.

## 7. Catálogo

- `app/products/page.tsx` y `app/products/[slug]/page.tsx` usan
  `useCatalogAvailability()` → `GET /api/catalog/availability`, que lee
  `inventory` y descuenta reservas vencidas. **El stock real manda**;
  `product.inStock` está marcado `@deprecated` y no decide la compra.
- El botón de compra se deshabilita por variante agotada.

## 8. Variantes

- `getProductOptions(product)` normaliza `options` genéricas o `colors/storage`
  legacy. `variantKeyForSelection()` produce la clave canónica
  (`color:x|storage:y`) compartida por carrito, pedido e inventario.
- Producto sin opciones usa `variant_key = ''`.

## 9. Pedido público

- `/pedido/[token]` usa `public_token` (no UUID interno), muestra estado,
  totales, PIN si aplica y botón de pago (Mercado Pago congelado).
- La reserva se libera si vence; el pago tardío re-reserva (migración 002).

## 10. Huecos que ataca esta fase

1. No hay confirmación explícita antes de crear el pedido.
2. El error de stock no dice qué SKU faltó.
3. El admin de inventario no permite ajustes ni historial global.
4. No hay buscador/filtros/estados visuales ni umbral editable desde la UI.
5. `umantai_integration` conserva datos de corridas previas: tests no
   reproducibles.
