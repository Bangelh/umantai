# LEGACY CATALOG MIGRATION

**Fase:** MULTI-STORE CATALOG · 2026-10-19
**Regla:** no big-bang. El catálogo de `lib/products.ts` se conserva hasta demostrar
que los lectores nuevos cubren todo el tráfico y que staging quedó comparable.

---

## 1. Punto de partida

El catálogo legacy son datos hardcodeados en `lib/products.ts` (`baseProductsData`)
más overrides editoriales en `product_overrides`.

La tienda legacy ya existe desde la migración 011:

| Campo | Valor |
|---|---|
| `stores.id` | `00000000-0000-0000-0000-000000000001` |
| `stores.slug` | `umantai` |
| `stores.is_default` | `TRUE` |
| `stores.active` | `FALSE` (no aparece en discovery) |

`umantai` es un slug reservado: ninguna tienda nueva puede tomarlo. La fila es la
dueña explícita de los productos migrados y **no** se convierte en una tienda
pública durante esta fase.

---

## 2. Qué migra el script

`scripts/migrate-legacy-catalog.ts` es idempotente y hace backfill hacia:

1. **`master_products`** — un producto canónico por slug legacy. Reutiliza la
   identidad `(normalized_name, brand)` si ya existe.
2. **`store_products`** — una fila por producto, con `store_id = <legacy>` y
   `master_product_id` apuntando al maestro. El precio legacy se convierte a
   centavos (`price * 100`).
3. **`product_variants`** — declara las combinaciones vendibles de
   `getProductOptions()`; no crea stock (el inventario legacy ya existe y se
   duplicaría).

No migra imágenes a storage: conserva las URLs editoriales. Las imágenes nuevas
subidas por comerciantes sí pasan por `lib/storage.server.ts`.

### Ejecución (solo staging)

```bash
railway run --service web node --import tsx scripts/migrate-legacy-catalog.ts
```

Requiere que 011–016 estén aplicadas. Se puede repetir: usa `ON CONFLICT` y no
duplica stock ni pedidos.

---

## 3. Comparación obligatoria antes de cambiar lectores

Ejecutar en staging y guardar la salida junto al deploy:

```sql
-- Conteo por origen
SELECT metadata->>'source' AS origen, COUNT(*) AS productos
  FROM store_products
 GROUP BY 1;

-- Productos legacy sin maestro (debe ser 0)
SELECT COUNT(*) FROM store_products
 WHERE store_id = '00000000-0000-0000-0000-000000000001'
   AND master_product_id IS NULL;

-- Variantes declaradas vs. SKUs con inventario
SELECT COUNT(*) AS variantes FROM product_variants
 WHERE store_id = '00000000-0000-0000-0000-000000000001';

-- La tienda legacy NO debe aparecer en discovery
SELECT COUNT(*) FROM stores
 WHERE id = '00000000-0000-0000-0000-000000000001' AND active;
```

Criterio de aceptación: mismo número de productos legacy, sin maestros
duplicados, y `umantai` ausente del buscador global.

---

## 4. Transición de lectores (sin romper URLs)

| Lector | Antes | Ahora | Retiro |
|---|---|---|---|
| `/` · `/api/search` | Solo `store_products` activos | Solo `store_products`; nunca consulta legacy | N/A |
| `/<store>` · `/<store>/p/<slug>` | Nuevo | `store_products` + `product_variants` + `inventory` | N/A |
| `/products` | Catálogo legacy con cards | **308 → `/`** | Borrar cuando no haya tráfico |
| `/products/<slug>` | Ficha legacy | **308 → `/?q=<nombre>`** | Borrar cuando no haya tráfico |
| `/negocio/<storeId>` | Formulario básico | Catálogo completo (maestro, propio, variantes, stock, imágenes) | N/A |
| `POST /api/orders` con tienda nueva | — | Resuelve `store_products`/`product_variants`, deriva la tienda | N/A |
| `POST /api/orders` sin tienda / `umantai` | Legacy | Rama de compatibilidad con `lib/products.ts` + overrides | Borrar al apagar la tienda legacy |
| `sitemap.xml` | Incluía `/products` | Solo home, institucionales, tiendas activas y productos visibles | N/A |

La rama legacy del checkout **no** acepta productos de tiendas nuevas y la rama
nueva **no** acepta `store_id` del navegador. Son caminos separados a propósito.

---

## 5. Orden de corte

1. Aplicar 016 en staging.
2. Ejecutar `seed-platform` (4 tiendas demo) y el backfill legacy.
3. Comparar (§3) y correr tests de integración.
4. Activar tiendas demo y verificar smoke multi-tienda.
5. Observar tráfico a `/products` y a la rama legacy de órdenes.
6. Recién entonces eliminar `lib/products.ts`, `product_overrides`,
   `app/products/*`, `lib/adminProductStore.ts` y los readers legacy.

No se elimina la tienda legacy en esta fase: sus pedidos históricos y snapshots
dependen de que `stores` y los datos migrados sigan existiendo.

---

## 6. Rollback

- **Datos:** el backfill solo inserta/actualiza filas nuevas con
  `metadata.source = 'legacy-catalog-migration'`; no borra `lib/products.ts` ni
  `product_overrides`. Un rollback de aplicación deja el catálogo legacy intacto.
- **Lectores:** revertir el deploy restaura `/products` y la rama legacy del
  checkout. Las tablas nuevas (016) pueden quedarse: son aditivas.
- **Migración 016:** es aditiva. Sus `ALTER TABLE` tienen default, y las tablas
  nuevas no reemplazan columnas existentes; no se requiere down para volver a
  desplegar el código anterior.

---

## 7. Condición para retirar legacy

Todas deben cumplirse:

- cero requests a `/products` en 30 días (o solo redirecciones de bots);
- ningún pedido nuevo por la rama legacy;
- títulos/precios/imágenes de pedidos históricos siguen visibles vía snapshot;
- tests de búsqueda no encuentran duplicados;
- backup verificado de `product_overrides`.

Hasta entonces, `lib/products.ts` queda como fuente del backfill y del panel
legacy `/admin`.
