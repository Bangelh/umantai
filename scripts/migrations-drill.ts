/**
 * scripts/migrations-drill.ts — verificación INDIVIDUAL de las migraciones.
 *
 * Levanta un PostgreSQL 17 efímero en localhost, aplica `db/migrations/001…007`
 * una por una y, después de CADA archivo, toma un fingerprint READ ONLY con
 * `auditSchema()`. Así se ve exactamente qué cambia 004, 005, 006 y 007, sin
 * tocar Producción, Preview ni QA.
 *
 * Uso:
 *   node --import tsx scripts/migrations-drill.ts
 *   node --import tsx scripts/migrations-drill.ts --out=migrations-drill.json
 *
 * Nunca lee una connection string externa ni imprime credenciales.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { auditSchema } from './audit-schema';

const MIGRATIONS = [
  '001_commerce_core.sql',
  '002_payment_confirmation.sql',
  '003_pickup_pin_kiosk.sql',
  '004_payment_webhook_diagnostics.sql',
  '005_duplicate_payment_guard.sql',
  '006_fulfillment_stock_conflict_guard.sql',
  '007_release_respects_rereservation.sql',
] as const;

/** Migraciones cuyo efecto se documenta antes/después. */
const DRILL_FROM = '004_payment_webhook_diagnostics.sql';

const PORT = 55433;
const USER = 'postgres';
const PASSWORD = 'postgres';
const DATABASE = 'umantai_migration_drill';

interface Step {
  migration: string;
  fingerprint: string;
  tables: number;
  columns: number;
  functions: number;
  triggers: number;
  indexes: number;
  constraints: number;
  expected: Array<{ id: string; present: boolean; detail: string }>;
}

function outPath(argv: string[]): string | null {
  const arg = argv.find((value) => value.startsWith('--out='));
  return arg ? arg.slice('--out='.length) : null;
}

async function main(): Promise<void> {
  const databaseDir = await mkdtemp(path.join(tmpdir(), 'umantai-migrations-'));
  const server = new EmbeddedPostgres({
    databaseDir,
    port: PORT,
    user: USER,
    password: PASSWORD,
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });

  let started = false;
  try {
    await server.initialise();
    await server.start();
    started = true;

    const admin = new Client({
      connectionString: `postgresql://${USER}:${PASSWORD}@localhost:${PORT}/postgres`,
    });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${DATABASE}`);
    } finally {
      await admin.end();
    }

    const url = `postgresql://${USER}:${PASSWORD}@localhost:${PORT}/${DATABASE}`;
    const client = new Client({ connectionString: url, application_name: 'umantai-migrations-drill' });
    await client.connect();

    const steps: Step[] = [];
    try {
      for (const migration of MIGRATIONS) {
        const sql = await readFile(path.join(process.cwd(), 'db', 'migrations', migration), 'utf8');
        await client.query(sql);

        // El fingerprint se toma con una conexión aparte (READ ONLY) para no
        // interferir con la sesión que aplicó la migración.
        const audit = await auditSchema(url, 'skip');
        steps.push({
          migration,
          fingerprint: audit.fingerprint,
          tables: audit.snapshot.tables.length,
          columns: audit.snapshot.columns.length,
          functions: audit.snapshot.functions.length,
          triggers: audit.snapshot.triggers.length,
          indexes: audit.snapshot.indexes.length,
          constraints: audit.snapshot.constraints.length,
          expected: audit.snapshot.expected.map((check) => ({
            id: check.id,
            present: check.present,
            detail: check.detail,
          })),
        });
      }
    } finally {
      await client.end();
    }

    const baseline = steps.find((step) => step.migration === '003_pickup_pin_kiosk.sql');
    const drill = steps.filter((step) => step.migration >= DRILL_FROM);
    const report = {
      generatedAt: new Date().toISOString(),
      postgres: '17',
      note: 'Cluster efímero en localhost. Sin datos de Producción, Preview ni QA.',
      baselineFingerprint: baseline?.fingerprint ?? null,
      steps,
      drill,
    };

    const json = `${JSON.stringify(report, null, 2)}\n`;
    const target = outPath(process.argv.slice(2));
    if (target) {
      await writeFile(target, json, 'utf8');
      console.log(`drill: ${steps.length} migraciones aplicadas; JSON en ${target}`);
    } else {
      console.log(json);
    }
  } finally {
    if (started) await server.stop().catch(() => undefined);
    await rm(databaseDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

void main().catch((error) => {
  console.error('drill:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

