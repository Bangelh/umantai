/**
 * lib/db-driver.server.ts — cliente SQL portable (Neon HTTP + node-postgres).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  POR QUÉ EXISTE
 *
 *  El motor transaccional usa `neon()` (driver HTTP de Neon) en dos archivos.
 *  Ese driver no funciona contra un PostgreSQL común: habla con el endpoint
 *  HTTP de Neon, no con el protocolo de Postgres. Para poder correr en Railway
 *  (o en cualquier Postgres gestionado) hace falta un segundo adaptador.
 *
 *  Este módulo conserva la MISMA interfaz que ya usan los llamadores:
 *
 *      const rows = await sql`SELECT ... ${value}`;
 *      const results = await sql.transaction([sql`...`, sql`...`]);
 *      const results = await sql.transaction([...], { readOnly: true });
 *
 *  y elige el driver así:
 *
 *      1. `DB_DRIVER=neon|pg` (explícito, gana siempre).
 *      2. Host `*.neon.tech` → Neon.
 *      3. Cualquier otro host → `pg` (Railway, Supabase, local).
 *
 *  QUÉ NO CAMBIA
 *
 *  · La lógica de negocio.
 *  · El SQL ni las funciones/triggers.
 *  · Mercado Pago.
 *  · El comportamiento por defecto en Neon (sigue siendo el driver HTTP).
 *
 *  TRANSACCIONES
 *
 *  Neon ejecuta un batch atómico sobre HTTP. Con `pg` se usa una conexión
 *  dedicada del pool: `BEGIN` → queries en orden → `COMMIT`, con `ROLLBACK`
 *  ante cualquier error. `{ readOnly: true }` se traduce a `BEGIN READ ONLY`,
 *  igual que en Neon.
 *
 *  CONEXIONES
 *
 *  El pool de `pg` es por proceso y por URL (máximo `PGPOOL_MAX`, default 1).
 *  En Railway el proceso es longevo y puede subirlo; en Vercel/Netlify cada
 *  instancia abre su pool y el pooler de transacción hace el resto. Neon no usa
 *  pool TCP.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { neon } from '@neondatabase/serverless';
import { Pool } from 'pg';

export type DbDriverName = 'neon' | 'pg';

export type Row = Record<string, unknown>;

/**
 * Consulta construida por el tagged template. En Neon conserva el objeto
 * interno del driver; en `pg` lleva el texto y los parámetros ya normalizados.
 */
export interface SqlQuery extends PromiseLike<Row[]> {
  /** Sólo lo usa el adaptador `pg`. */
  readonly text?: string;
  /** Sólo lo usa el adaptador `pg`. */
  readonly values?: readonly unknown[];
}

export interface TransactionOptions {
  readOnly?: boolean;
}

export interface SqlClient {
  (strings: TemplateStringsArray, ...values: unknown[]): SqlQuery;
  transaction(queries: readonly SqlQuery[], options?: TransactionOptions): Promise<Row[][]>;
}

// =============================================================================
//  SELECCIÓN DE DRIVER
// =============================================================================

/**
 * Decide el driver. Un `DB_DRIVER` desconocido falla cerrado: mejor un error
 * explícito que conectar con el driver equivocado.
 */
export function resolveDbDriver(url: string, explicit?: string | null): DbDriverName {
  const forced = (explicit ?? '').trim().toLowerCase();
  if (forced === 'neon' || forced === 'pg') return forced;
  if (forced) throw new Error(`db_driver_invalid:${forced}`);

  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'neon.tech' || host.endsWith('.neon.tech')) return 'neon';
  } catch {
    // URL no parseable: que lo explique `pg` al conectar.
  }
  return 'pg';
}

// =============================================================================
//  SQL TAG
// =============================================================================

/**
 * Convierte un tagged template en SQL parametrizado (`$1`, `$2`, …).
 * No deduplica valores: cada interpolación ocupa su propio parámetro.
 */
export function buildSqlText(
  strings: TemplateStringsArray,
  values: readonly unknown[],
): { text: string; values: unknown[] } {
  if (values.length !== strings.length - 1) {
    throw new Error('db_driver_template_mismatch');
  }

  let text = strings[0] ?? '';
  for (let index = 0; index < values.length; index += 1) {
    text += `$${index + 1}${strings[index + 1] ?? ''}`;
  }

  return { text, values: [...values] };
}

// =============================================================================
//  ADAPTADOR pg
// =============================================================================

type Executor = (text: string, values: readonly unknown[]) => Promise<Row[]>;

class PgSqlQuery implements SqlQuery {
  readonly text: string;
  readonly values: readonly unknown[];

  constructor(
    text: string,
    values: readonly unknown[],
    private readonly execute: Executor,
  ) {
    this.text = text;
    this.values = values;
  }

  then<TResult1 = Row[], TResult2 = never>(
    onfulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute(this.text, this.values).then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<Row[] | TResult> {
    return this.execute(this.text, this.values).catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<Row[]> {
    return this.execute(this.text, this.values).finally(onfinally);
  }
}

function poolMax(): number {
  const parsed = Number(process.env.PGPOOL_MAX);
  // En serverless cada instancia debe abrir UNA conexión y dejar que el pooler
  // de transacción multiplexe. Antes el default era 10 por instancia y, con el
  // pooler de sesión (tope 15), bastaban dos instancias para agotarlo.
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.min(Math.max(Math.trunc(parsed), 1), 50);
}

/**
 * Pools por URL. NUNCA se cierra el pool de otra URL al cambiar de cadena.
 *
 * Antes había un solo slot: si un módulo resolvía la cadena de runtime (6543) y
 * otro la de migraciones (5432), cada llamada cerraba el pool del anterior y
 * dejaba clientes cacheados apuntando a un pool terminado. Producción lo
 * mostró como "Cannot use a pool after calling end on the pool": el health
 * respondía 503 y el panel 500 con la base perfectamente sana.
 */
const poolsByUrl = new Map<string, Pool>();

/** `pg` marca `ending` al llamar a `end()`; ese pool ya no acepta consultas. */
function isEndedPool(pool: Pool): boolean {
  return (pool as { ending?: boolean }).ending === true;
}

function isEndedPoolError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('after calling end on the pool');
}

function createPool(url: string): Pool {
  const pool = new Pool({
    connectionString: url,
    max: poolMax(),
    application_name: 'umantai',
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });

  // Un cliente idle que muere no debe tumbar el proceso.
  pool.on('error', (error) => {
    console.error('[db] idle pg client error:', error.message);
  });

  return pool;
}

function getPool(url: string): Pool {
  const existing = poolsByUrl.get(url);
  if (existing && !isEndedPool(existing)) return existing;

  const pool = createPool(url);
  poolsByUrl.set(url, pool);
  return pool;
}

async function runPgTransaction(
  pool: Pool,
  queries: readonly SqlQuery[],
  options?: TransactionOptions,
): Promise<Row[][]> {
  const client = await pool.connect();
  try {
    await client.query(options?.readOnly ? 'BEGIN READ ONLY' : 'BEGIN');

    const results: Row[][] = [];
    for (const query of queries) {
      if (typeof query.text !== 'string') {
        throw new Error('db_driver_pg_query_missing_text');
      }
      const params = query.values ? [...query.values] : [];
      const result = await client.query(query.text, params);
      results.push(result.rows as Row[]);
    }

    await client.query('COMMIT');
    return results;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // El error original es el útil; el rollback puede fallar si la conexión murió.
    }
    throw error;
  } finally {
    client.release();
  }
}

function createPgClient(url: string): SqlClient {
  const runQuery = async (text: string, values: readonly unknown[]): Promise<Row[]> => {
    try {
      return (await getPool(url).query(text, [...values])).rows as Row[];
    } catch (error) {
      if (!isEndedPoolError(error)) throw error;
      // Otro camino cerró el pool: se descarta y se reintenta una sola vez.
      poolsByUrl.delete(url);
      return (await getPool(url).query(text, [...values])).rows as Row[];
    }
  };

  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const { text, values: params } = buildSqlText(strings, values);
    return new PgSqlQuery(text, params, runQuery);
  }) as unknown as SqlClient;

  tag.transaction = (queries, options) => runPgTransaction(getPool(url), queries, options);
  return tag;
}

// =============================================================================
//  ADAPTADOR Neon
// =============================================================================

function createNeonClient(url: string): SqlClient {
  const neonSql = neon(url);

  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) =>
    neonSql(strings, ...values)) as unknown as SqlClient;

  // `neon().transaction` conserva la semántica de batch atómico sobre HTTP.
  const neonTransaction = neonSql.transaction as unknown as (
    queries: readonly SqlQuery[],
    options?: TransactionOptions,
  ) => Promise<Row[][]>;

  tag.transaction = (queries, options) => neonTransaction(queries, options);
  return tag;
}

// =============================================================================
//  API PÚBLICA
// =============================================================================

/**
 * Crea el cliente SQL para una connection string. El driver se decide por
 * `DB_DRIVER` o por el host; nunca se registra la URL.
 */
export function createSqlClient(url: string, explicitDriver?: string | null): SqlClient {
  const driver = resolveDbDriver(url, explicitDriver ?? process.env.DB_DRIVER);
  return driver === 'neon' ? createNeonClient(url) : createPgClient(url);
}

/** Cierra todos los pools de `pg` (tests, scripts y apagado ordenado). */
export async function closeDbPools(): Promise<void> {
  const pools = [...poolsByUrl.values()];
  poolsByUrl.clear();
  await Promise.all(pools.map((pool) => pool.end().catch(() => undefined)));
}
