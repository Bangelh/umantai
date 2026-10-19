# MULTI-STORE CATALOG

**Estado:** implementado en staging (rama `feat/railway-staging`)
**Alcance:** catálogo maestro, catálogo por tienda, variantes, inventario,
imágenes, carrito y pedido de UNA sola tienda.

---

## 1. Modelo

```
master_products (global, sin precio/stock)
        │ 0..1 (nullable)
        ▼
store_products (pertenece a UNA tienda; precio, moneda, publicación)
        │ 0..N
        ▼
product_variants (option_values genéricos, SKU, precio override opcional)
        │
        ▼
inventory (store_id, product_slug, variant_key) ← ledger append-only
```

### MasterProduct

Campos núcleo: `id`, `slug`, `name`, `normalized_name`, `brand?`, `category?`,
`description?`, `image_url?`, `attributes JSONB`, `active`, `archived_at`,
timestamps. No tiene precio ni stock ni campos propios de alimentos: sirve para
arroz, tela, polo, martillo o zapatos.

Implementación: `lib/master.server.ts` · UI `/admin/catalogo`.

### StoreProduct

`store_id`, `master_product_id?`, `slug`, `name`, `brand?`, `category?`,
`description?`, `image_url?`, `price_cents`, `currency`, `unit`, `visible`,
`option_schema`, `archived_at`, timestamps.

- Producto desde maestro: `master_product_id` informado; nombre/marca/categoría
  se heredan si la tienda no los sobreescribe.
- Producto propio: `master_product_id = NULL`; nunca se promueve solo al maestro.
- `slug` es único **por tienda** `(store_id, slug)`. Dos tiendas pueden vender
  `/bodega-a/p/arroz-costeno` y `/market-b/p/arroz-costeno`.

Implementación: `lib/store-catalog.server.ts`.

### Variantes

```json
// store_products.option_schema
[{"name":"talla","values":["S","M","L"]},{"name":"color","values":["negro","blanco"]}]

// product_variants
{
  "variant_key": "color:negro|talla:m",
  "sku": "polo-algodon-m-negro",
  "option_values": {"talla":"M","color":"negro"},
  "price_cents": 4390
}
```

- Genéricas: no hay columnas `talla`/`color` obligatorias.
- `variant_key` es la identidad estable que comparte `inventory`; se deriva de
  los valores normalizados y ordenados.
- Todas las variantes de un producto usan los mismos ejes.
- `sku` único por tienda; se genera si no se envía.
- Producto sin variantes usa `variant_key = ''`.

---

## 2. Inventario

No se escribe con `UPDATE` directo. Todo pasa por
`inventory_apply_movement(..., p_store_id)`:

- `on_hand`, `reserved`, `available` (generada), `reorder_point`.
- Movimientos en `inventory_movements` con `store_id`, motivo, actor e
  idempotencia.
- La base rechaza stock negativo o disponible menor a lo reservado.
- Sin `store_id` explícito, la función usa la tienda del pedido; nunca mezcla
  tiendas. Una membresía de A no autoriza stock de B (portero en la app + WHERE
  con `store_id`).
- Ajustes merchant: `POST /api/merchant/stores/:storeId/inventory`.
- Conteo de SKU publicados para planes:
  `countPublishedSkusByStore(storeId)` (no bloquea todavía).

---

## 3. Platform Admin vs Store Admin

| | Platform Admin | Store Admin |
|---|---|---|
| Ruta | `/admin`, `/admin/catalogo` | `/negocio/<storeId>` |
| Credencial | `ADMIN_API_SECRET` (`x-admin-token`) | Sesión Better Auth + `store_members` |
| Alcance | Catálogo maestro global, aprobar tiendas, QA | Su tienda: productos, precio, variantes, stock, imágenes |
| Puede editar el maestro | Sí | No |
| Puede editar otra tienda | No aplica | No (404, no revela nombre) |

Endpoints de plataforma:

```
GET    /api/admin/master-products?q=&category=&brand=&includeArchived=1
POST   /api/admin/master-products
PATCH  /api/admin/master-products
GET    /api/admin/master-products/facets
POST   /api/admin/media                      (imagen de maestro)
```

Endpoints de tienda:

```
GET    /api/merchant/master-products?q=...   (solo lectura del maestro)
GET    /api/merchant/stores/:storeId/products
POST   /api/merchant/stores/:storeId/products
PATCH  /api/merchant/stores/:storeId/products/:productId
POST   /api/merchant/stores/:storeId/products/:productId/variants
PATCH  /api/merchant/stores/:storeId/products/:productId/variants/:variantId
POST   /api/merchant/stores/:storeId/inventory
POST   /api/merchant/stores/:storeId/media   (logo o imagen de producto)
```

---

## 4. Experiencia pública

- `/` — buscador global. Filas compactas, **sin imagen por defecto**. Muestra
  tienda, distancia, disponibilidad y precio (mínimo de variantes si aplica).
- `/<store>` — identidad, ubicación general, búsqueda interna y lista compacta
  de productos publicados.
- `/<store>/p/<slug>` — detalle, descripción, variantes, precio, stock, imagen
  si existe y agregar al carrito.
- `/products` y `/products/<slug>` — solo compatibilidad (308).
- El sitemap incluye únicamente tiendas activas y productos visibles/no
  archivados.

Búsqueda en español: `normalize_search_text()` traduce tildes/ñ, ordena espacios
y se indexa con `pg_trgm`. No se agrega Elasticsearch/Algolia. La misma
normalización existe en JS (`normalizeSearchText`) para filtros y tests.

---

## 5. Imágenes / storage

Implementación: `lib/storage.server.ts`.

| Driver | Cuándo | Persistencia |
|---|---|---|
| `db` (default) | staging sin credenciales R2 | `media_assets.data` (bytea), servido por `/api/media/<key>` |
| `r2` | `MEDIA_DRIVER=r2` + credenciales | bucket S3-compatible; `media_assets` guarda metadatos |

Reglas:

- Key generada por el servidor: `<scope>/<owner>/<uuid>.<ext>`; nunca el nombre
  original.
- Validación por magic bytes (JPEG/PNG/WebP) y tamaño máximo 2 MB.
- `../`, `//` y keys no conformes se rechazan en app y en la base.
- `R2_PUBLIC_BASE_URL` es opcional; sin ella se sirve por el proxy de la app.
- Archivar marca `archived_at`; no se borra el binario para no romper URLs
  cacheadas o referencias históricas.
- Staging y Producción deben usar buckets/credenciales distintos. No se usan
  credenciales de Producción en staging.

### Configuración pendiente (staging)

```env
MEDIA_DRIVER=r2
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=umantai-staging-media
R2_PUBLIC_BASE_URL=            # opcional
```

Mientras no existan, staging usa `db` y la fase no se bloquea.

---

## 6. Carrito y pedido de una tienda

El carrito guarda `storeId`, `storeSlug`, `storeName` y todas sus líneas
pertenecen a esa tienda.

- Carrito vacío → adopta la tienda del producto.
- Misma tienda → agrega.
- Otra tienda → devuelve `conflict`; la UI muestra “Mantener carrito” o
  “Cambiar de tienda”. Cambiar vacía el carrito anterior de forma explícita.
- No hay checkout mixto, split payments, suborders, payout ni fulfillment
  multi-store.

`POST /api/orders` no confía en precios, totales ni `store_id` del navegador:

1. Resuelve `storeSlug` contra `stores` activas.
2. Resuelve cada `productSlug` contra `store_products` de esa tienda.
3. Exige `visible = TRUE` y `archived_at IS NULL`.
4. Resuelve la variante real por `variant_key` y su precio efectivo.
5. Rechaza líneas con hints de otra tienda (`mixed_store_cart`, 409).
6. Lee disponibilidad fresca y luego reserva con el motor transaccional.
7. Guarda snapshot: nombre, marca, variante, `variant_sku`, unit price y line
   total.

Productos archivados no rompen pedidos históricos: las líneas conservan su
snapshot.

---

## 7. Migraciones

- **016** (`db/migrations/016_multi_store_catalog.sql`): normalización de
  búsqueda, columnas de maestro/store product, `product_variants`,
  `order_items.variant_sku`, `media_assets` y triggers. Aditiva e idempotente en
  lo razonable.
- 001–015 no se editan.
- Aplicar solo en staging. El test efímero aplica 001–016.
- `npm run test:integration` resetea únicamente una base cuyo nombre contenga
  `test` o `integration`.

---

## 8. Seed de staging

`scripts/seed-platform.ts` crea/actualiza:

| Tienda | Rubro | Demuestra |
|---|---|---|
| Bodega La Esquina | abarrotes | producto con presentaciones 1 kg / 5 kg |
| Hilos & Estilo | ropa | talla/color y stock por combinación |
| Telas del Sur | telas | color/ancho |
| Ferretería Central | ferretería | producto sin variantes |

`Arroz Costeño` existe como maestro y se vende en más de una tienda con distinto
precio y stock. El seed es idempotente: no duplica tiendas ni suma stock.

> El seed de staging no crea usuarios automáticamente. Usa `SEED_OWNER_EMAIL`
> para asignar las tiendas a un usuario ya registrado y probar el panel merchant.

---

## 9. Tests

```bash
npm test                 # unitarios (incluye carrito single-store)
npm run test:integration # PostgreSQL real efímero/local
```

Cobertura nueva:

- maestro: crear, duplicado por nombre+marca, búsqueda con acentos, archivar;
- store product: desde maestro, propio, editar, archivar;
- variantes: ejes, SKU, inventario independiente, variante inválida;
- carrito: primera tienda, misma tienda, conflicto, cambio de tienda;
- pedido: tienda derivada, cross-store, precio server-side, no publicado,
  tienda inactiva, stock insuficiente, stock por variante;
- seguridad: merchant A no lee/escribe B;
- búsqueda: sin duplicados, acentos, disponibilidad, geo;
- historial: producto archivado no rompe pedido;
- storage: MIME inválido, tamaño, key segura, autorización store-scoped.

---

## 10. Deuda y riesgos conocidos

- El catálogo legacy sigue vivo para la tienda `umantai` y el panel `/admin`
  legacy; retirarlo requiere el corte descrito en `LEGACY_CATALOG_MIGRATION.md`.
- `unaccent` no se usa: la normalización es una función propia con el alfabeto
  español. Si se agregan otros idiomas, revisar.
- R2 no se ha probado contra un bucket real (faltan credenciales de staging); el
  driver `db` cubre staging.
- `media_assets` con driver `db` guarda binarios en Postgres; no usar para
  catálogos masivos. Migrar a R2 antes de volumen alto.
- Las imágenes no se re-codifican (solo se validan); un PNG/JPEG/WebP malicioso
  dentro del límite de 2 MB podría consumir CPU al servirse. Serving es directo,
  sin procesamiento.
- No hay RLS: el aislamiento depende del portero de aplicación y de `store_id`
  en cada WHERE. Endurecer con rol no-owner + RLS queda como deuda.
- Los límites de plan (25/50/100 SKU) aún no se aplican; solo existe el conteo.
- Mercado Pago sigue congelado; el pedido queda `pending_payment`.
