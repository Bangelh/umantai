/**
 * scripts/apply-migrations.ts — aplica migraciones SQL explícitas.
 *
 * Uso:
 *   node --import tsx scripts/apply-migrations.ts 019 020
 *
 * Reglas:
 *   · solo acepta nombres existentes en db/migrations (prefijo numérico);
 *   · las migraciones del proyecto son idempotentes;
 *   · se niega a correr con APP_ENV=production salvo --allow-production;
 *   · imprime solo el nombre aplicado, nunca la URL ni credenciales.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';

import { getDatabaseUrl } from '../lib/db';

async function main() {
  const args = process.argv.slice(2);
  const allowProduction = args.includes('--allow-production');
  const requested = args.filter((arg) => !arg.startsWith('--'))

  if (requested.length === 0) {
    console.error('Uso: node --import tsx scripts/apply-migrations.ts 019 020 [--allow-production]');
    process.exit(1);
  }

  if (process.env.APP_ENV === 'production' && !allowProduction) {
    console.error('Rechazado: APP_ENV=production. Pasa --allow-production solo con autorización explícita.');
    process.exit(1);
  }

  const url = getDatabaseUrl();
  if (!url) {
    console.error('Falta la URL de PostgreSQL.');
    process.exit(1);
  }

  const dir = path.join(process.cwd(), 'db', 'migrations');
  const available = await readdir(dir);
  const files = requested.map((name) => {
    // Un prefijo (`001`) también coincide con `001_..._down.sql`, que ordena
    // antes alfabéticamente: sin este filtro, provisionar una base nueva aplicaba
    // el rollback. El nombre exacto sí puede apuntar a un `.down.sql`.
    const match =
      available.find((file) => file === name) ??
      available.find((file) => file.startsWith(`${name}_`) && !file.endsWith('.down.sql'));
    if (!match) {
      throw new Error(`No existe una migración que empiece con "${name}".`);
    }
    return match;
  });

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    for (const file of [...new Set(files)]) {
      const content = await readFile(path.join(dir, file), 'utf8');
      await client.query(content);
      console.info(`aplicada ${file}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('[migrations] falló:', error instanceof Error ? error.message : error);
  process.exit(1);
});
