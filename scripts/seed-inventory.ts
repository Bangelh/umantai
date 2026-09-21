/**
 * scripts/seed-inventory.ts
 *
 * Siembra el stock inicial del catálogo en `inventory` como movimientos `receipt`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  POR QUÉ ES NECESARIO
 *
 *  `inventory_apply_movement()` crea el SKU en 0 si no existe y luego exige que
 *  quede disponible >= 0. Con `inventory` vacía, TODO `POST /api/orders` responde
 *  409 `insufficient_stock`. Este script es el paso previo obligatorio.
 *
 *  POR QUÉ RE-EJECUTARLO ES SEGURO
 *
 *  Cada siembra usa una `idempotency_key` estable (`seed:v1:<slug>:<variante>`).
 *  El índice único de `inventory_movements` hace que un reintento devuelva el
 *  movimiento existente en vez de duplicar stock. Además el script lee primero
 *  las claves ya aplicadas, así que tampoco hace viajes de más.
 *
 *  OJO CON LAS VARIANTES
 *
 *  El selector de color/almacenamiento de `app/products/[slug]/page.tsx` todavía
 *  es decorativo: llama a `addItem(product)` sin opciones, así que hoy el carrito
 *  manda SIEMPRE `variant_key = ''`. Por eso cada producto siembra su SKU base.
 *  Las combinaciones color × almacenamiento se siembran además para cuando se
 *  conecte el selector — con la MISMA clave que genera `buildVariantKey()`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  USO
 *
 *    npx tsx scripts/seed-inventory.ts                  # escribe (base + variantes)
 *    npx tsx scripts/seed-inventory.ts --dry-run        # reporta sin escribir nada
 *    npx tsx scripts/seed-inventory.ts --base-only      # solo el SKU sin variante
 *    npx tsx scripts/seed-inventory.ts --location=MAIN  # otro local/locker
 *
 *  Lee `POSTGRES_URL_NON_POOLING` desde `.env.local`. Asegúrate de que apunte al
 *  branch de Neon de DESARROLLO, no a producción.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { config as loadEnv } from 'dotenv';
import type { ProductVariant } from '../lib/commerce';
import type { Product } from '../lib/products';

// Cargamos el entorno ANTES de evaluar cualquier módulo de la app: `lib/env.ts`
// lee `process.env` al importarse. Por eso los imports de la app son dinámicos
// (dentro de `main()`): un `import` estático se evaluaría antes de estas líneas.
// (Los `import type` de arriba sí pueden ser estáticos: se borran al compilar.)
loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

const SEED_TAG = 'seed:v1';

interface Flags {
  dryRun: boolean;
  baseOnly: boolean;
  location: string;
}

interface SeedTarget {
  productSlug: string;
  productName: string;
  variantKey: string;
  variantLabel: string;
  quantity: number;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { dryRun: false, baseOnly: false, location: 'MAIN' };

  for (const arg of argv) {
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--base-only') flags.baseOnly = true;
    else if (arg.startsWith('--location=')) {
      flags.location = arg.slice('--location='.length).trim() || 'MAIN';
    }
  }

  return flags;
}

/** Clave estable que hace la siembra idempotente. `base` evita un key con cola vacía. */
function seedKey(target: Pick<SeedTarget, 'productSlug' | 'variantKey'>): string {
  return `${SEED_TAG}:${target.productSlug}:${target.variantKey || 'base'}`;
}

/**
 * Expande el catálogo a una fila por SKU.
 * El stock sale del override de /admin si existe, para no sembrar un número viejo.
 */
function buildTargets(
  products: Product[],
  overrides: Record<string, Record<string, unknown>>,
  flags: Flags,
  buildVariantKey: (variant?: ProductVariant) => string,
): SeedTarget[] {
  const targets: SeedTarget[] = [];

  for (const base of products) {
    const override = overrides[base.slug] ?? {};
    const rawStock = override.inStock;
    const stock = typeof rawStock === 'number' && Number.isFinite(rawStock) ? rawStock : base.inStock;

    // `inStock <= 0` significa oculto en el catálogo (y `inventory_apply_movement`
    // rechaza un movimiento con ambos deltas en cero). Se omite a propósito.
    const quantity = Math.floor(stock);
    if (quantity <= 0) continue;

    // 1) SKU sin variante: el que consume el carrito hoy.
    targets.push({
      productSlug: base.slug,
      productName: base.name,
      variantKey: '',
      variantLabel: 'sin variante',
      quantity,
    });

    if (flags.baseOnly) continue;

    // 2) Cada combinación color × almacenamiento.
    const colors: Array<string | null> = base.colors?.length ? base.colors : [null];
    const storages: Array<string | null> = base.storage?.length ? base.storage : [null];

    for (const color of colors) {
      for (const storage of storages) {
        if (color === null && storage === null) continue; // ya cubierto por el SKU base

        const variant: ProductVariant = { color, storage };
        targets.push({
          productSlug: base.slug,
          productName: base.name,
          variantKey: buildVariantKey(variant),
          variantLabel: [color, storage].filter(Boolean).join(' · '),
          quantity,
        });
      }
    }
  }

  return targets;
}

/** Claves ya sembradas, para no repetir llamadas ni inflar el conteo del reporte. */
async function readSeededKeys(): Promise<Set<string>> {
  const { sql } = await import('../lib/db');
  if (!sql) return new Set();

  const result = await sql`
    SELECT idempotency_key
      FROM inventory_movements
     WHERE idempotency_key LIKE ${`${SEED_TAG}:%`}
  `;

  const rows = result.rows as Array<{ idempotency_key: string }>;
  return new Set(rows.map((row) => row.idempotency_key));
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));

  const [{ baseProductsData }, { getAllOverrides, hasDatabaseConnection }, { buildVariantKey }, commerceServer] =
    await Promise.all([
      import('../lib/products'),
      import('../lib/db'),
      import('../lib/commerce'),
      import('../lib/commerce.server'),
    ]);

  if (!hasDatabaseConnection() || !commerceServer.isCommerceDbConfigured()) {
    console.error('✗ No hay base de datos configurada.');
    console.error('  Define POSTGRES_URL_NON_POOLING en .env.local con la cadena DIRECTA');
    console.error('  (sin "-pooler") del branch de Neon que quieras sembrar.');
    process.exit(1);
  }

  console.log('🌱 Seed de inventario — Umantai');
  console.log(`   local: ${flags.location}${flags.dryRun ? '  ·  🧪 DRY RUN (no escribe)' : ''}`);

  const overrides = await getAllOverrides();
  const targets = buildTargets(baseProductsData, overrides, flags, buildVariantKey);
  const seeded = await readSeededKeys();

  console.log(`\n📦 ${targets.length} SKU(s) objetivo · ${seeded.size} ya sembrado(s) antes\n`);

  let applied = 0;
  let skipped = 0;
  let failed = 0;

  for (const target of targets) {
    const key = seedKey(target);
    const label = target.variantKey
      ? `${target.productSlug} → ${target.variantLabel}`
      : `${target.productSlug} → (sin variante)`;

    if (seeded.has(key)) {
      skipped += 1;
      continue;
    }

    if (flags.dryRun) {
      console.log(`  · ${label}  +${target.quantity}`);
      applied += 1;
      continue;
    }

    try {
      // Único camino sancionado para tocar stock: nunca un UPDATE directo.
      await commerceServer.applyInventoryMovement({
        productSlug: target.productSlug,
        variantKey: target.variantKey,
        movementType: 'receipt',
        onHandDelta: target.quantity,
        locationCode: flags.location,
        reason: 'initial catalog seed',
        performedBy: 'seed-inventory',
        idempotencyKey: key,
      });

      applied += 1;
      console.log(`  ✓ ${label}  +${target.quantity}`);
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  ✗ ${label}: ${message}`);
    }
  }

  console.log(`\n${flags.dryRun ? '🧪 DRY RUN — no se escribió nada' : '✅ Seed terminado'}`);
  console.log(`   aplicados: ${applied} · omitidos (ya existían): ${skipped} · fallidos: ${failed}`);

  if (!flags.dryRun && applied > 0) {
    console.log('\n   Verifica el resultado:');
    console.log('     SELECT product_slug, variant_key, quantity_on_hand, quantity_available');
    console.log('       FROM inventory ORDER BY product_slug, variant_key;');
  }

  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('\n✗ El seed falló:', error);
  process.exit(1);
});
