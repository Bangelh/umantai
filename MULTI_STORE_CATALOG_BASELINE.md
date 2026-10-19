# MULTI-STORE CATALOG — BASELINE

**Fecha:** 2026-10-19
**Alcance:** auditoría corta antes de unificar catálogo legacy y multi-tienda.
**No** es un inventario exhaustivo: identifica dependencias y el camino de migración.

---

## 1. Qué sigue siendo legacy

| Pieza | Rol actual | Estado |
|---|---|---|
| `lib/products.ts` → `baseProductsData` | Catálogo hardcodeado de la fase 1 (electrónica, Whole Foods, etc.). | **Legacy**. Autoridad de nombre/marca/precio/imagen en `/products` y en el checkout sin tienda. |
| `lib/adminProductStore.ts` | Overrides de precio/nombre/stock guardados en `product_overrides`, aplicados en cliente. | **Legacy**. `inStock` ya no es autoridad; el stock real vive en `inventory`. |
| `product_overrides` | Tabla de overrides editoriales por `slug` legacy. | **Legacy**, se conserva para no romper `/admin`. |
| `app/products/page.tsx` | Antes: catálogo público con cards grandes e imágenes. | **Compatibilidad**: hoy redirige 308 a `/`; el archivo se retira cuando no haya enlaces externos. |
| `app/products/[slug]/page.tsx` | Antes: ficha legacy + carrito. | **Compatibilidad**: hoy redirige 308 a `/?q=<nombre>`; el detalle vive en `/<store>/p/<slug>`. |
| `app/admin/*` | Panel de catálogo/precios/stock legacy. | **Legacy**; se mantiene temporalmente. |
| `app/api/admin/inventory/*` | Inventario operado sobre `baseProductsData`. | **Legacy**. |
| `scripts/seed-inventory.ts` | Seed de inventario legacy. | **Legacy**. |
| `app/sitemap.ts` | Antes publicaba `/products`. | **Actualizado**: solo home, institucionales, tiendas activas y productos visibles. |
| Checkout sin `storeSlug` en `POST /api/orders` | Resuelve contra `baseProductsData` + overrides y tienda `umantai`. | **Compatibilidad**; se conserva mientras dure la transición. |

## 2. Qué ya usa StoreProduct

- `lib/stores.server.ts`: `getStorefront`, `getStoreProductDetail`, `listStoreProducts`, `resolveCheckoutProducts`.
- `/api/search` y la home: buscan únicamente `store_products` + `stores` activas.
- `app/[store]/page.tsx` y `app/[store]/p/[slug]/page.tsx`.
- `/negocio/<storeId>`: panel merchant con lectura/creación de `store_products`.
- Checkout con `storeSlug`: resuelve precio contra `store_products` (nunca contra el navegador).
- `scripts/seed-platform.ts`: 4 tiendas demo con productos, variantes y stock propios.
- `master_products`: catálogo canónico con API y UI de Platform Admin (`/admin/catalogo`).
- `/<store>`: vitrina con búsqueda interna; `/<store>/p/<slug>`: detalle con variantes e imagen opcional.
- `product_variants` e `inventory` comparten `variant_key`; cada tienda tiene su propio stock.
- `media_assets`: storage DB (staging) o R2 (cuando existan credenciales).
- `/negocio/<storeId>`: catálogo merchant completo (propio/maestro, variantes, stock, publicar/archivar).

## 3. Rutas que dependen de `lib/products.ts`

- `app/admin/page.tsx` (panel legacy; no es el catálogo nuevo)
- `app/api/catalog/overrides/route.ts` (solo lectura pública de overrides legacy)
- `app/api/admin/inventory/route.ts`, `receipt-plan/route.ts`, `ledger/route.ts`
- `app/api/orders/route.ts` (solo rama legacy sin `storeSlug`)
- `app/api/products/[slug]/route.ts`
- `app/sitemap.ts`
- `scripts/seed-inventory.ts`, `scripts/seed-payload-collections.ts`
- Tests de catálogo/inventario legacy.

## 4. Cómo migrar sin big-bang

1. **016+**: agregar normalización, variantes, archivo e imágenes al modelo nuevo. No editar 001–015.
2. **Backfill**: crear `master_products` y `store_products` para cada producto legacy, asociados a la tienda `umantai` (UUID fijo, inactiva). Script idempotente `scripts/migrate-legacy-catalog.ts`.
3. **Comparar**: validar conteos y que el catálogo legacy no aparezca duplicado en la búsqueda global (la tienda legacy sigue inactiva).
4. **Cambiar lectores**: `/products` deja de ser una segunda experiencia y redirige a `/`; `/products/<slug>` redirige a una búsqueda por nombre. El checkout nuevo usa solo `store_products`; la rama legacy queda solo para pedidos sin tienda o con la tienda `umantai`.
5. **Retirar**: cuando no haya tráfico a `/products`, eliminar `app/products/*`, `adminProductStore`, la rama legacy de `POST /api/orders` y los seeds legacy. `baseProductsData` queda solo como fuente del backfill y del panel `/admin` legacy hasta ese momento.

## 5. Qué se puede retirar al final

- `app/products/page.tsx` y `app/products/[slug]/page.tsx`.
- `lib/adminProductStore.ts` y `product_overrides` (tras migrar overrides publicados a `store_products`/`master_products`).
- Rama legacy de `POST /api/orders` y `lib/catalogAvailability` legacy.
- `app/api/admin/inventory/*` legacy (reemplazado por inventario store-scoped).
- `scripts/seed-inventory.ts` y el catálogo en `sitemap.ts`.

## 6. Decisiones de esta fase

- **Un carrito = una tienda.** El carrito guarda `storeId`, `storeSlug` y `storeName`; agregar otra tienda exige confirmación y reemplazo explícito.
- **El servidor deriva la tienda** desde `(storeSlug, productSlug)` en `store_products`; nunca acepta `store_id` como verdad.
- **Variantes genéricas** (`option_schema` + `product_variants`) con `variant_key` estable; el inventario sigue usando `(store_id, product_slug, variant_key)`.
- **Imágenes**: la búsqueda global sigue sin fotos; el detalle, la vitrina y los paneles sí las muestran.
- **Storage**: adaptador con driver `db` (bytea) como fallback de staging y driver `r2` (S3 compatible) para cuando existan credenciales de staging. La única configuración pendiente es `MEDIA_DRIVER=r2` + las cinco variables R2.
- **Alcance del MVP**: un carrito/pedido = una tienda. No hay split payments, suborders, payout ni fulfillment multi-store.
- **Platform Admin vs Store Admin**: `/admin/catalogo` (token de plataforma) define el maestro; `/negocio/<storeId>` (sesión + membresía) define precio, stock y publicación de SU tienda.

## 7. Estado al cierre de la fase

- Auditoría: este documento.
- Migración legacy: `scripts/migrate-legacy-catalog.ts` + `LEGACY_CATALOG_MIGRATION.md`.
- Migración 016 aplicada solo en staging; 001–015 intactas.
- Tests: `tests/multi-store-catalog.integration.test.ts` (PostgreSQL real) y `tests/cart.single-store.test.ts`.
- Pendiente de infraestructura: credenciales R2 de staging (no bloquea: driver `db` activo).
