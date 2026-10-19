# PHASE 2 BASELINE — Analytics + Legal + Frontend

Auditoría corta del estado real antes de tocar código (2026-10-19, rama
`feat/railway-staging`, HEAD `2ab10db`). No es una auditoría exhaustiva: solo lo
que condiciona esta fase.

## 1. Panel admin actual

| Pantalla | Estado |
| --- | --- |
| `/admin` | Editor de productos/overrides 100% cliente. Sin KPIs ni ventas. |
| `/admin/inventario` | Real: stock por SKU, entradas, ajustes, punto de reorden, ledger. |
| `/admin/kiosco` | Cola de preparación + PIN de retiro. |
| `/admin/notes` | Notas internas. |

- Auth: `x-admin-token` contra `ADMIN_API_SECRET` (`lib/admin.server.ts`, comparación
  en tiempo constante, falla cerrado con 503). **No hay roles ni sesión de usuario.**
- No existe layout/nav compartido de admin: cada página repite su gate de token.
- No existe `/admin/analytics` ni ninguna API de métricas.

## 2. Datos disponibles

`orders` (001): `status` (enum de 11 valores), `payment_status`, `total`,
`subtotal`, `discount_total`, `shipping_total`, `item_count`, `currency`,
`created_at`, `confirmed_at`, `fulfillment_type`, `channel`.
`order_items`: `product_slug`, `product_name`, `product_brand`, `variant_key`,
`quantity`, `unit_price`, `line_total`.
`inventory`: `product_slug`, `variant_key`, `quantity_on_hand`,
`quantity_reserved`, `quantity_available` (generada), `reorder_point`,
`is_active`, `location_code`.
`inventory_movements`: ledger append-only.

Todo lo necesario para el dashboard existe. **No hace falta migración para
analytics**; solo índices si una consulta lo demuestra (ver §9).

## 3. Estados de pedido (fuente de verdad: `lib/commerce.ts` + trigger SQL)

`pending_payment`, `confirmed`, `preparing`, `ready_for_pickup`, `picked_up`,
`out_for_delivery`, `delivered`, `completed`, `cancelled`, `expired`, `refunded`.

Terminales sin venta: `cancelled`, `expired`, `refunded`.
`pending_payment` retiene stock pero **no es venta** (aún no hay pago).
`confirmed` es el primer estado con pago confirmado (`payment_status = paid`).
`expired` puede revivir a `confirmed` por pago tardío (migración 002), así que una
venta puede aparecer con `created_at` anterior al período pero `confirmed_at`
dentro. El dashboard cuenta por `created_at` y lo documenta.

## 4. UI existente

- Estética dark fija (`bg-neutral-950`, blanco con opacidades), Tailwind v4, Geist.
- Sin tokens semánticos: colores y opacidades repetidos a mano (`text-white/60`,
  `border-white/10`, …).
- `app/globals.css` solo define `background/foreground`; no hay estados
  `success`/`warning`/`destructive` ni jerarquía de texto.
- `MobileBottomNav` existe pero **no está montado en el layout** → en móvil no hay
  navegación inferior.
- No hay footer con enlaces legales.
- Muchas páginas públicas son `"use client"` completas (home, products, detalle,
  carrito), lo que impide `generateMetadata` directo en ellas.

## 5. SEO actual

- Solo `app/layout.tsx` tiene `metadata` (title/description/icon). Sin
  `metadataBase`, sin Open Graph, sin Twitter, sin canonical.
- **No hay** `robots.txt`, `sitemap.xml` ni metadatos por página.
- No hay imágenes `<img>`/`next/image` en el frontend (las tarjetas usan
  gradientes/emoji), así que no hay ALT faltante hoy; queda como requisito para
  cuando se agreguen fotos reales.
- URLs: `/`, `/products`, `/products/[slug]`, `/cart`, `/pedido/[token]`,
  `/kiosk`, `/list`. Comprensibles; no se cambian.

## 6. Legal / contacto

- No existe ninguna página legal, ni política de cookies, ni formulario de
  contacto.
- No hay datos legales del negocio en el repo (razón social, RUC, dirección,
  correo legal): **no se inventan** (ver `config/business.ts`).
- WhatsApp ya se configura por `NEXT_PUBLIC_WHATSAPP_*`.

## 7. Cookies / almacenamiento real

- `localStorage`: `umantai-cart`, lista de compras, `umantai-session-id`,
  `umantai-admin-token`, actor de inventario.
- Cookies de sesión de Supabase (`@supabase/ssr`) para el CMS/Payload.
- **No hay** analytics, píxeles ni marketing. Por eso no corresponde banner de
  consentimiento; sí una política que declare solo almacenamiento necesario.

## 8. Notificaciones / contacto

- Resend ya está integrado en `lib/notifications.server.ts` (envío al comprador),
  con degradación segura cuando falta `RESEND_API_KEY`.
- No hay canal de contacto entrante ni bandeja de mensajes.

## 9. Performance / índices

- `orders` tenía índices por estado y por expiración, pero no por `created_at`.
  Como el dashboard filtra y agrupa por fecha, se agrega **009**
  (`idx_orders_created_at`). Las líneas se unen por `order_id`, que ya está
  indexado: no hay N+1 ni índices adicionales.
- No se agrega librería de charts: el gráfico se resuelve con SVG propio (0 KB de
  dependencia nueva).
- **010** agrega `contact_messages` para que el formulario no dependa de Resend.

## 10. Riesgos detectados

1. `RAILWAY_GIT_COMMIT_SHA` desfasado con `railway up` (corregido en esta fase con
   un manifiesto de build embebido).
2. Contar `pending_payment` como venta inflaría ingresos: se define una regla
   explícita y testeada.
3. Límites de fecha en UTC corren el día comercial peruano: se usa
   `America/Lima` explícito.
4. Sin roles: cualquier portador de `ADMIN_API_SECRET` ve analytics y datos de
   clientes agregados. Aceptado para esta fase; se resuelve con auth real.
