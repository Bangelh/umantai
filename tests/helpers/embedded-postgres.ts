/**
 * tests/helpers/embedded-postgres.ts — PostgreSQL REAL y efímero para tests.
 *
 * Levanta un cluster local con `embedded-postgres` (PG 17), crea una base *   `umantai_test` y aplica `db/migrations/001…020.sql` en orden.
 *
 * Reglas de seguridad:
 *   · Nunca lee `DATABASE_URL` ni ninguna URL externa.
 *   · Escucha sólo en localhost y en un puerto fijo de test.
 *   · Usa un directorio temporal que se borra al terminar.
 *   · No toca Producción, Preview ni QA.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';

const TEST_PORT = 55432;
const TEST_DATABASE = 'umantai_test';
const TEST_USER = 'postgres';
const TEST_PASSWORD = 'postgres';

const MIGRATIONS = [
  '001_commerce_core.sql',
  '002_payment_confirmation.sql',
  '003_pickup_pin_kiosk.sql',
  '004_payment_webhook_diagnostics.sql',
  '005_duplicate_payment_guard.sql',
  '006_fulfillment_stock_conflict_guard.sql',
  '007_release_respects_rereservation.sql',
  '008_inventory_ledger_filters.sql',
  '009_analytics_orders_index.sql',
  '010_contact_messages.sql',
  '011_stores.sql',
  '012_auth.sql',
  '013_catalog.sql',
  '014_store_scoping.sql',
  '015_search_indexes.sql',
  '016_multi_store_catalog.sql',
  '017_plans_subscriptions.sql',
  '018_subscription_created_events.sql',
  '019_platform_admins.sql',
  '020_tenant_guards.sql',
  '021_email_outbox.sql',
  '022_rls_tenant_isolation.sql',
] as const;

export interface EmbeddedTestDatabase {
  /** URL de la base de test (efímera local o staging externo explícito). */
  url: string;
  /** `true` cuando la URL vino de `INTEGRATION_DATABASE_URL` (staging/test DB). */
  external?: boolean;
  stop(): Promise<void>;
}

/**
 * Base para los tests de integración.
 *
 * - Sin `INTEGRATION_DATABASE_URL`: cluster efímero local (default seguro).
 * - Con `INTEGRATION_DATABASE_URL`: resetea el schema `public` de ESA base y
 *   aplica 001–020. Así cada corrida arranca limpia y no arrastra inventario de
 *   pruebas anteriores. Guards: el nombre de la base debe contener `test` o
 *   `integration` (p. ej. `umantai_integration`); si no, aborta.
 *
 * Nunca apuntar a Producción ni a la base `railway` de staging.
 */
export async function startTestDatabase(): Promise<EmbeddedTestDatabase> {
  const external = (process.env.INTEGRATION_DATABASE_URL ?? '').trim();
  if (external) {
    await resetExternalTestDatabase(external);
    return { url: external, external: true, stop: async () => undefined };
  }
  return startEmbeddedPostgres();
}

function databaseNameFromUrl(connectionString: string): string {
  try {
    return decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, '')) || 'postgres';
  } catch {
    throw new Error('INTEGRATION_DATABASE_URL no es una URL válida.');
  }
}

/**
 * Resetea una base de TEST externa. Destructivo por diseño, pero acotado:
 *   · solo `public` (no toca roles, extensiones ni otras DBs);
 *   · exige que el nombre de la base sea de test/integración;
 *   · reaplica TODAS las migraciones, así el esquema también es reproducible.
 */
async function resetExternalTestDatabase(connectionString: string): Promise<void> {
  const databaseName = databaseNameFromUrl(connectionString);
  if (!/(test|integration)/i.test(databaseName)) {
    throw new Error(
      `INTEGRATION_DATABASE_URL apunta a "${databaseName}". Por seguridad, el reset automático ` +
        'solo se permite en bases cuyo nombre contenga "test" o "integration".',
    );
  }

  const needsSsl = /sslmode=(require|verify)/i.test(connectionString);
  const client = new Client({
    connectionString,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  try {
    console.info(`[integration] reseteando schema public de ${databaseName}`);
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    for (const file of MIGRATIONS) {
      const sql = await readFile(path.join(process.cwd(), 'db', 'migrations', file), 'utf8');
      await client.query(sql);
    }
  } finally {
    await client.end();
  }
}

export async function startEmbeddedPostgres(): Promise<EmbeddedTestDatabase> {
  const databaseDir = await mkdtemp(path.join(tmpdir(), 'umantai-pg-'));

  const server = new EmbeddedPostgres({
    databaseDir,
    port: TEST_PORT,
    user: TEST_USER,
    password: TEST_PASSWORD,
    persistent: false,
    // Windows inicializa en WIN1252 por defecto y las migraciones tienen
    // caracteres UTF-8 (→, ·, acentos). Sin esto, el primer COMMENT falla.
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });

  let started = false;

  try {
    await server.initialise();
    await server.start();
    started = true;

    const adminUrl = `postgresql://${TEST_USER}:${TEST_PASSWORD}@localhost:${TEST_PORT}/postgres`;
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
    } finally {
      await admin.end();
    }

    const url = `postgresql://${TEST_USER}:${TEST_PASSWORD}@localhost:${TEST_PORT}/${TEST_DATABASE}`;
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      for (const file of MIGRATIONS) {
        const sql = await readFile(path.join(process.cwd(), 'db', 'migrations', file), 'utf8');
        await client.query(sql);
      }
    } finally {
      await client.end();
    }

    return {
      url,
      stop: async () => {
        await server.stop().catch(() => undefined);
        await rm(databaseDir, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  } catch (error) {
    if (started) await server.stop().catch(() => undefined);
    await rm(databaseDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
