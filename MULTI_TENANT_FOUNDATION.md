# MULTI-TENANT + DISCOVERY FOUNDATION

**Fecha:** 2026-10-19
**Rama:** `feat/railway-staging` (sin merge a `main`)
**Entorno aplicado:** Railway **staging** únicamente
**Mercado Pago:** congelado (no se tocaron Preferences, Orders, webhook, credenciales ni callbacks)

---

## 1. Qué cambia conceptualmente

UMANTAI deja de ser “una tienda con productos” y pasa a ser:

1. **Buscador local** (`umantai.com/`): el usuario busca `arroz`, `polo`, `tela`, `martillo`,
   `zapatos`… y ve productos de varias tiendas, con precio, distancia y disponibilidad.
2. **Plataforma multi-tienda**: cada comercio es una `Store`, raíz de tenancy, con su
   vitrina, catálogo, inventario, pedidos y analytics.
3. **Una identidad** para cliente y comerciante (Better Auth).

No se asume ningún rubro: `stores.category` y `store_products.category` son texto libre.
El seed usa abarrotes, ropa, telas y ferretería precisamente para probarlo.

---

## 2. Arquitectura

```
umantai.com/
├─ /                         Home-buscador (Server Component + DiscoveryHome)
├─ /api/search               Búsqueda global (productos + tiendas + metadata)
├─ /<store-slug>             Vitrina pública
├─ /<store-slug>/p/<slug>    Detalle de producto
├─ /ingresar                 Login / registro (Better Auth)
├─ /cuenta                   Perfil + historial del cliente
├─ /vender                   Onboarding de comercio (crea Store inactiva)
├─ /negocio                  Tiendas del usuario
├─ /negocio/<storeId>        Panel de una tienda (KPIs, productos, pedidos)
├─ /products, /cart…         Catálogo legacy de la fase 1 (tienda interna)
└─ /api/auth/*               Better Auth
```

### Capas

| Capa | Archivo | Responsabilidad |
|---|---|---|
| Dominio puro | `lib/geo.ts`, `lib/discovery.ts`, `lib/tenancy.ts` | Haversine, radios, ranking, slugs, roles |
| Datos | `lib/stores.server.ts` | SQL store-scoped, aislamiento, catálogo, pedidos |
| Auth | `lib/auth.server.ts` | Better Auth, sesión, cookie |
| API | `app/api/search`, `app/api/merchant/*`, `app/api/account/*` | Validación + HTTP |
| UI | `app/page.tsx`, `app/[store]`, `app/negocio`, `app/vender`, `app/cuenta` | Listas densas |

---

## 3. Modelo de datos (migraciones 011–015)

> **001–010 no se editaron.** Toda la evolución va en migraciones nuevas,
> idempotentes (`IF NOT EXISTS` / `DO $$`), compatibles con los datos QA existentes.

### 011 — `stores`

- `id, name, slug, description, logo_url, image_url, category, address, district, city,
  latitude, longitude, contact_email, contact_phone, active, is_default, approved_at,
  metadata, created_at, updated_at`.
- Slug único `lower(slug)`; trigger `stores_validate_slug` valida formato y reservados.
- `reserved_store_slugs`: `admin, api, login, legal, contacto, products, cart, list,
  kiosk, pedido, cuenta, negocio, vender, search, debug, brand, images…`.
- `CHECK (NOT active OR (latitude IS NOT NULL AND longitude IS NOT NULL))`: una tienda
  visible siempre tiene ubicación.
- Tienda **legacy** con UUID fijo `00000000-0000-0000-0000-000000000001` (slug `umantai`,
  `active=false`, `is_default=true`): dueña del catálogo/pedidos de la fase 1.

### 012 — Auth

`users`, `sessions`, `auth_accounts`, `verifications` (Better Auth),
`customer_profiles`, `store_members (store_id, user_id, role owner|admin)`.

### 013 — Catálogo

- `master_products`: catálogo canónico global (nombre, marca, categoría, descripción,
  imagen opcional, activo). **Sin precio.**
- `store_products`: `store_id`, `master_product_id` **opcional**, `slug` único por tienda,
  `price_cents` (BIGINT), `currency`, `unit`, `visible`, datos propios.
- Un producto propio de una tienda simplemente tiene `master_product_id = NULL`.

### 014 — Store scoping del motor transaccional

- `orders.store_id` (NOT NULL, default legacy) + `orders.user_id` (nullable).
- `inventory.store_id`; la unicidad pasa a
  `(store_id, location_code, product_slug, variant_key)`.
- `inventory_movements.store_id` (backfill desde `inventory`).
- `inventory_apply_movement(...)` ahora acepta `p_store_id` **al final** (default NULL):
  1. usa `p_store_id`;
  2. si no, la tienda del pedido;
  3. si no, la tienda default/legacy.
  Si la tienda explícita y la del pedido no coinciden → `store_scope_mismatch`.
  El resto de funciones (`reserve/release/commit/rereserve`) sigue funcionando sin cambios
  porque resuelven la tienda desde el pedido.

### 015 — Índices de búsqueda

- `pg_trgm` (extensión estándar, **no** PostGIS) + GIN en nombre/marca/categoría de
  productos y nombre de tienda.
- `geo_distance_km(lat1,lng1,lat2,lng2)` en SQL, `IMMUTABLE`, misma fórmula que JS.
- Índices btree `(latitude, longitude) WHERE active` para el bounding box.

### Estrategia de migración

1. Los registros existentes **nunca** quedan con `store_id NULL`: se backfillean
   explícitamente a la tienda legacy y luego se aplica `NOT NULL`.
2. No se editaron 001–010.
3. Los datos QA de staging conservan su historia; sus pedidos pertenecen a `umantai`
   (tienda interna), que no aparece en el buscador.
4. El seed de plataforma es idempotente y se puede re-ejecutar.

---

## 4. Geolocalización

- **Sin PostGIS.** Bounding box indexable + Haversine exacto.
- Default: **5 km**. Opciones de UI: 1, 2, 5, 10, 20 km; la API acepta 1–50.
- La home **no** llama a `navigator.geolocation` sola: muestra “Usar mi ubicación”.
  Si el permiso se rechaza o falla, se abre el selector manual de zona/coordenadas.
- La ubicación se guarda en `sessionStorage` (se borra al cerrar la pestaña). No se
  persiste en la base ni se asocia a la cuenta.
- La búsqueda funciona **sin** ubicación (global, `distanceKm = null`).

---

## 5. Search API

```http
GET /api/search?q=arroz&lat=-12.0464&lng=-77.0428&radius=5&limit=20&offset=0
```

- `q`: hasta 80 caracteres, normalizado (espacios/control chars).
- `lat`/`lng`: juntos o ausentes; rangos validados.
- `radius`: 1–50 (default 5).
- `limit`: 1–50 (default 20); `offset`: 0–1000.
- Respuesta: `{ products[], stores[], metadata { q, location, radiusKm, limit, offset,
  total, hasMore, generatedAt } }`.

**Rendimiento:** dos consultas por request.

1. productos: join `store_products` + `stores` + `master_products`, disponibilidad
   agregada con `LATERAL` (no N+1), `COUNT(*) OVER()` para el total.
2. tiendas: agregado de productos y disponibles, mismo filtro geográfico.

Orden: `relevancia` (exacto → prefijo → contiene → marca/categoría → maestro) →
distancia → disponibilidad → nombre.

---

## 6. Home y UI de alta densidad

- Lista, no marketplace de cards: **sin fotografía de producto** en resultados.
- Cada fila: **nombre**, `tienda · distancia`, **precio** (mono, tabular) y
  `Disponible/Agotado`.
- Tiendas: fila compacta con logo (si existe), nombre, rubro, distancia y conteo.
- Móvil primero: buscador de 56 px, chips de radio, resultados en una columna.
- Desktop: mismo ancho de lectura (~1024 px), no cards gigantes.
- Sección “¿Tienes un negocio?” con CTA a `/vender` y “Conocer planes”.
- Logo: `components/brand/BrandLogo.tsx` usa `public/brand/umantai-logo.svg` si existe;
  si no, wordmark. **No se inventó un logo nuevo.**

---

## 7. Aislamiento multi-tenant (P0)

### Enforcement

- Toda función privada recibe `userId` + `storeId` y llama a `requireStoreAccess` **antes**
  de consultar.
- El SQL privado filtra siempre por `store_id`; un ID de otra tienda devuelve 404/403
  (nunca datos).
- Las rutas de merchant obtienen el usuario de la cookie de Better Auth, jamás de un
  parámetro del cliente.
- Analytics recibe `storeId` opcional; el panel lo pasa validado por membresía.

### Pruebas (`tests/multi-tenant.integration.test.ts`, PostgreSQL 17 real)

- B no puede **leer** productos de A.
- B no puede **crear/editar** productos de A.
- B no puede **leer pedidos** de A.
- B no puede **acceder** al panel/analytics de A (`store_forbidden`).
- Cada tienda ve solo su catálogo.
- Un usuario puede pertenecer a varias tiendas y elegir cuál abrir.
- Analytics de A y B suman solo sus propios pedidos.

### Por qué no RLS

La app conecta con un único rol dueño del schema; RLS no aportaría aislamiento real sin
un rol no-owner y `FORCE ROW LEVEL SECURITY`. Se implementó el aislamiento en la capa de
datos (una sola puerta) y se prueba con integración real. Endurecer con rol dedicado +
RLS queda como deuda explícita.

---

## 8. Checkout

| Caso | Comportamiento |
|---|---|
| Guest | `contactEmail` obligatorio; `orders.user_id = NULL`; funciona igual. |
| Autenticado | si hay cookie, `orders.user_id` se completa; el email puede salir de la sesión. |
| Producto de tienda | el precio y el nombre se resuelven en `store_products` en el servidor. |
| Catálogo legacy | se mantiene el catálogo base + overrides de `/admin`, asociado a la tienda legacy. |
| Carrito mixto | el checkout se bloquea: un pedido pertenece a una sola tienda. |
| Historial | solo `orders.user_id`; las compras de invitado no se reclaman por email. |

Mercado Pago sigue congelado: no se modificó ninguna Preference, Order, webhook ni
credencial. El flujo de confirmación interna sigue igual.

---

## 9. Staging seed

`npm run seed:platform` (idempotente) crea:

| Tienda | Rubro | Coordenadas | Distancia aprox. a Lima Centro |
|---|---|---|---|
| Bodega La Esquina | abarrotes | -12.05, -77.045 | 0,5 km |
| Hilos & Estilo | ropa | -12.085, -77.05 | 4,4 km |
| Telas del Sur | telas | -12.13, -77.03 | 9,5 km |
| Ferretería Central | ferretería | -12.18, -77.02 | 15,1 km |

Productos: `arroz costeño`, `aceite`, `leche` (agotada), `polo básico`, `casaca`,
`zapatillas`, `tela de lino`, `tela de seda`, `tela de algodón`, `martillo`, `taladro`,
`cinta métrica`. Permite probar radio 1/5/10/20, texto, marca y producto agotado.

---

## 10. Deuda técnica

1. **Frontend legacy**: `/products`, `/cart` y `/admin` siguen con el diseño de la fase 1
   (cards con imagen). La home y las vitrinas nuevas son densas; unificarlas es una tarea
   aparte para no romper la compra existente.
2. **Sin variantes en `store_products`**: un producto de tienda no tiene ejes
   color/talla todavía. El catálogo legacy sí; se puede modelar cuando un comercio lo
   necesite.
3. **Sin imágenes en resultados** (decisión de producto) y sin uploader de imágenes:
   `image_url` se acepta por API, el detalle la muestra si existe.
4. **Aprobación de tiendas** por `ADMIN_API_SECRET` (`GET/PATCH /api/admin/stores`), sin
   rol de plataforma todavía. No hay UI de moderación; el endpoint es la base.
5. **Sin checkout multi-tienda**: un pedido = una tienda. El carrito avisa y bloquea el
   checkout mixto.
6. **`fn inventory_apply_movement`** quedó con 12 argumentos; el código nuevo pasa
   `storeId`, el legacy sigue usando el default. Conviene migrar el resto de los call
   sites a explícito.
7. **RLS** no implementado (ver §7).
8. **Búsqueda**: ILIKE + trigram; no hay sinónimos, tolerancia a errores ni ranking
   aprendido (fuera de alcance).
9. **Mapas**: el selector manual usa presets de Lima. Para otras ciudades se agregan en
   `lib/locations.ts`; no hay geocoding inverso ni mapas.

---

## 11. Riesgos

- **Datos legales pendientes**: privacidad incluye geolocalización, pero razón social,
  RUC, jurisdicción y plazos siguen como `[PENDIENTE]`.
- **Registro sin verificación de email**: riesgo de suplantación de correo en el historial
  (mitigado: historial solo por `user_id`). Activar verificación antes de abrir registro.
- **Slug y marca**: `umantai` queda reservado; la tienda legacy es invisible. Cambiar el
  catálogo legacy a una tienda visible requiere decisión de producto.
- **Staging con datos QA**: los pedidos históricos pertenecen a la tienda legacy; no
  aparecen en analytics de comercios nuevos (correcto, pero hay que saberlo al leer KPIs).
- **Sin PostGIS**: suficiente para radios urbanos; si se necesitan polígonos o millones de
  filas, migrar `latitude/longitude` a `geography(Point)`.

---

## 12. Qué falta para “Multi-Store Catalog” completo

- Unificar el catálogo legacy (`baseProductsData`/overrides) con `store_products`.
- Variantes por tienda (talla/color/presentación) y edición de producto en el panel.
- Uploader de logo/imágenes y storage.
- UI de aprobación/moderación de tiendas.
- Planes y suscripciones (sin inventar cobro).
- Verificación de email y recuperación de contraseña.
- Checkout multi-tienda o carrito por tienda explícito.
- Roles de plataforma (reemplazar `ADMIN_API_SECRET`).
- RLS con rol no-owner (defensa en profundidad).
