#!/usr/bin/env node
/**
 * scripts/pg-dump.mjs — pg_dump sin exponer credenciales en argumentos.
 *
 * Lee la URL desde una variable de entorno (por defecto
 * `POSTGRES_URL_NON_POOLING`) y ejecuta `pg_dump` pasando host/puerto/usuario/
 * password por entorno (`PGHOST`, `PGPASSWORD`, …), nunca por la línea de
 * comandos. La URL no se imprime.
 *
 * Uso:
 *   node --env-file=.env.local scripts/pg-dump.mjs --out=backups/qa.dump
 *   node --env-file=.env.local scripts/pg-dump.mjs --out=backups/qa-schema.dump --schema-only
 *
 * Variables:
 *   PG_DUMP_URL     URL de conexión (default: POSTGRES_URL_NON_POOLING → DATABASE_URL)
 *   PG_DUMP_BIN     Ruta a pg_dump (default: .tools/pgsql/bin/pg_dump[.exe] o PATH)
 *   PG_DUMP_FORMAT  Formato (default: custom)
 */

import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

function arg(name) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

const out = arg('out');
if (!out) {
  console.error('pg-dump: falta --out=<archivo>');
  process.exit(1);
}

const url = process.env.PG_DUMP_URL || process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL;
if (!url) {
  console.error('pg-dump: falta PG_DUMP_URL / POSTGRES_URL_NON_POOLING / DATABASE_URL');
  process.exit(1);
}

let parsed;
try {
  parsed = new URL(url);
} catch {
  console.error('pg-dump: la URL de conexión no es parseable');
  process.exit(1);
}

const format = arg('format') || 'custom';
const schemaOnly = process.argv.includes('--schema-only');

const env = {
  ...process.env,
  PGHOST: parsed.hostname,
  PGPORT: parsed.port || '5432',
  PGUSER: decodeURIComponent(parsed.username || 'postgres'),
  PGPASSWORD: decodeURIComponent(parsed.password || ''),
  PGDATABASE: decodeURIComponent(parsed.pathname.replace(/^\//, '') || 'postgres'),
  PGSSLMODE: parsed.searchParams.get('sslmode') || 'prefer',
  PGCONNECT_TIMEOUT: process.env.PGCONNECT_TIMEOUT || '20',
  PGAPPNAME: 'umantai-pg-dump',
};

const candidates = [
  process.env.PG_DUMP_BIN,
  path.join(process.cwd(), '.tools', 'pgsql', 'bin', process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump'),
  'pg_dump',
].filter(Boolean);

const args = ['--format', format, '--no-owner', '--no-privileges', '--file', out];
if (schemaOnly) args.push('--schema-only');
if (format === 'custom') args.push('--compress=9');

let used = null;
for (const bin of candidates) {
  const probe = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  if (probe.status === 0) {
    used = bin;
    break;
  }
}
if (!used) {
  console.error('pg-dump: pg_dump no está disponible (definí PG_DUMP_BIN).');
  process.exit(1);
}

console.log(`pg-dump: usando ${path.basename(used)}${schemaOnly ? ' (schema-only)' : ''}`);
const result = spawnSync(used, args, { env, stdio: ['ignore', 'inherit', 'inherit'] });
if (result.status !== 0) {
  console.error(`pg-dump: falló con código ${result.status ?? result.error?.message}`);
  process.exit(result.status || 1);
}

const bytes = statSync(out).size;
const hash = createHash('sha256');
await new Promise((resolve, reject) => {
  createReadStream(out)
    .on('data', (chunk) => hash.update(chunk))
    .on('end', resolve)
    .on('error', reject);
});
console.log(`pg-dump: ${out} (${bytes} bytes) sha256=${hash.digest('hex')}`);
