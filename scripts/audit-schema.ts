/**
 * scripts/audit-schema.ts — fingerprint READ-ONLY del esquema PostgreSQL.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  QUÉ HACE
 *
 *  Se conecta a una base, abre una transacción `READ ONLY`, lee el catálogo y
 *  emite un resumen + un fingerprint reproducible (SHA-256) para comparar dos
 *  bases: por ejemplo Neon (origen) y Railway (staging) antes de un cutover.
 *
 *  QUÉ NO HACE
 *
 *  · No ejecuta DDL ni DML. No crea, altera, borra ni escribe nada.
 *  · La garantía real no es un regex: es `BEGIN READ ONLY`. Si alguna consulta
 *    intentara escribir, PostgreSQL la rechaza con SQLSTATE 25006.
 *  · No imprime la connection string, el usuario, el host ni ningún secreto.
 *    Sólo muestra `postgresql://<redacted>/<database>`.
 *  · No lee `.env.local` por su cuenta: la URL llega por variable de entorno.
 *
 *  USO
 *
 *    node --import tsx scripts/audit-schema.ts
 *    node --import tsx scripts/audit-schema.ts --json
 *    node --import tsx scripts/audit-schema.ts --counts=all
 *    node --import tsx scripts/audit-schema.ts --counts=skip
 *
 *  VARIABLE DE CONEXIÓN (en orden)
 *
 *    AUDIT_DATABASE_URL
 *    POSTGRES_URL_NON_POOLING
 *    POSTGRES_URL
 *    DATABASE_URL
 *
 *  El fingerprint cubre SÓLO el esquema (tablas, columnas, constraints,
 *  índices, funciones, triggers y presencia de migraciones). NO incluye
 *  conteos de filas, que cambian con la operación y se informan aparte.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';

// =============================================================================
//  TIPOS
// =============================================================================

export type CountMode = 'key' | 'all' | 'skip';

export interface AuditOptions {
  json: boolean;
  counts: CountMode;
}

interface Row {
  [column: string]: unknown;
}

export interface ColumnSnapshot {
  table: string;
  column: string;
  dataType: string;
  udtName: string;
  nullable: boolean;
  default: string | null;
  generated: boolean;
}

export interface ConstraintSnapshot {
  table: string;
  name: string;
  type: string;
  definition: string;
}

export interface IndexSnapshot {
  table: string;
  name: string;
  definition: string;
}

export interface FunctionSnapshot {
  name: string;
  args: string;
  returns: string;
  language: string;
  bodyHash: string;
}

export interface TriggerSnapshot {
  table: string;
  name: string;
  definition: string;
}

export interface TableCount {
  table: string;
  rows: number | string | null;
  error?: string;
}

export interface ExpectedCheck {
  id: string;
  present: boolean;
  detail: string;
}

export interface MigrationMarkers {
  duplicatePaymentGuard: boolean;
  fulfillmentReadyGuard: boolean;
  fulfillmentCommitGuard: boolean;
  fulfillmentPickupGuard: boolean;
  releaseRereservation: boolean;
}

export interface SchemaSnapshot {
  serverVersion: string;
  database: string;
  tables: Array<{ name: string; type: string }>;
  columns: ColumnSnapshot[];
  constraints: ConstraintSnapshot[];
  indexes: IndexSnapshot[];
  functions: FunctionSnapshot[];
  triggers: TriggerSnapshot[];
  expected: ExpectedCheck[];
}

export interface AuditResult {
  target: string;
  fingerprint: string;
  snapshot: SchemaSnapshot;
  counts: TableCount[];
}

/** Campos que SÍ forman parte del fingerprint (el resto es volátil entre hosts). */
export type FingerprintSource = Pick<
  SchemaSnapshot,
  'tables' | 'columns' | 'constraints' | 'indexes' | 'functions' | 'triggers' | 'expected'
>;

// =============================================================================
//  LÓGICA PURA (testeable sin base de datos)
// =============================================================================

/**
 * Frases permitidas como PRIMERA palabra. Todo lo demás se rechaza antes de
 * mandarlo al servidor. La transacción READ ONLY sigue siendo la garantía final.
 */
const READ_ONLY_PREFIXES = new Set(['select', 'with']);

/** Quita comentarios `--` al inicio para poder validar la primera palabra. */
function stripLeadingLineComments(sql: string): string {
  let rest = sql.trim();
  while (rest.startsWith('--')) {
    const newline = rest.indexOf('\n');
    if (newline === -1) return '';
    rest = rest.slice(newline + 1).trim();
  }
  return rest;
}

/**
 * Valida que una sentencia sea de lectura y de UN solo statement.
 * Lanza si no lo es. No pretende ser un parser SQL: es un candado barato que
 * complementa la transacción READ ONLY.
 */
export function assertReadOnlySql(sql: string): string {
  const trimmed = sql.trim();
  if (!trimmed) throw new Error('audit_schema: empty statement');

  const withoutTrailingSemicolon = trimmed.replace(/;\s*$/, '');
  if (withoutTrailingSemicolon.includes(';')) {
    throw new Error('audit_schema: multiple statements are not allowed');
  }

  const body = stripLeadingLineComments(withoutTrailingSemicolon);
  const firstWord = body.split(/\s+/, 1)[0]?.toLowerCase() ?? '';
  if (!READ_ONLY_PREFIXES.has(firstWord)) {
    throw new Error(`audit_schema: refusing non-read-only statement (${firstWord || 'unknown'})`);
  }

  return trimmed;
}

/** Valida un identificador antes de interpolarlo entre comillas dobles. */
export function quoteIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error('audit_schema: unsafe identifier');
  }
  return `"${name}"`;
}

/** Normaliza texto del catálogo para que el fingerprint no dependa de CRLF. */
export function normalizeDefinition(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/**
 * Objetivo enmascarado. Nunca devuelve usuario, password ni host.
 * `postgresql://user:placeholder@host:5432/neondb?sslmode=require`
 *   → `postgresql://<redacted>/neondb`
 */
export function describeTarget(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    const database = url.pathname.replace(/^\//, '') || '(default)';
    return `${url.protocol}//<redacted>/${database}`;
  } catch {
    return 'postgresql://<redacted>/(unknown)';
  }
}

/** Elimina credenciales y tokens de cualquier texto que vaya a imprimirse. */
export function redactSecrets(input: string): string {
  return input
    .replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gi, 'postgresql://<redacted>')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer <redacted>')
    .replace(/\b(APP_USR|TEST)-[A-Za-z0-9-]+/gi, '$1-<redacted>')
    .replace(/\bre_[A-Za-z0-9]{8,}\b/g, 're_<redacted>')
    .replace(/\b(password|passwd|pwd)\s*=\s*[^\s&;]+/gi, '$1=<redacted>');
}

/** Serialización canónica: claves y arrays ordenados de forma determinista. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(canonicalize)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      ordered[key] = canonicalize(source[key]);
    }
    return ordered;
  }
  return value;
}

/** SHA-256 del snapshot canónico. Mismo esquema ⇒ mismo hash. */
export function computeFingerprint(snapshot: unknown): string {
  const payload = JSON.stringify(canonicalize(snapshot));
  return `sha256:${createHash('sha256').update(payload, 'utf8').digest('hex')}`;
}

/**
 * Fingerprint del ESQUEMA, no del servidor.
 *
 * Excluye `serverVersion` y `database`: Railway y Neon tendrán builds y nombres
 * distintos aunque el esquema sea idéntico. Incluirlos haría que el hash nunca
 * coincida y el fingerprint dejaría de servir para comparar.
 */
export function fingerprintSchema(source: FingerprintSource): string {
  return computeFingerprint({
    tables: source.tables,
    columns: source.columns,
    constraints: source.constraints,
    indexes: source.indexes,
    functions: source.functions,
    triggers: source.triggers,
    expected: source.expected,
  });
}

/**
 * Evalúa la presencia de los objetos que cada migración 001–007 introduce.
 * No ejecuta nada: sólo compara nombres y marcadores ya leídos del catálogo.
 */
export function evaluateExpectedMigrations(input: {
  tables: string[];
  functions: string[];
  hasExpiredToConfirmed: boolean;
  markers: MigrationMarkers;
}): ExpectedCheck[] {
  const tables = new Set(input.tables);
  const functions = new Set(input.functions);

  type Requirement =
    | { kind: 'table'; name: string }
    | { kind: 'function'; name: string }
    | { kind: 'marker'; ok: boolean; name: string };

  const check = (id: string, requirements: Requirement[]): ExpectedCheck => {
    const missing = requirements
      .filter((requirement) => {
        if (requirement.kind === 'table') return !tables.has(requirement.name);
        if (requirement.kind === 'function') return !functions.has(requirement.name);
        return !requirement.ok;
      })
      .map((requirement) => requirement.name);

    return {
      id,
      present: missing.length === 0,
      detail: missing.length === 0 ? 'OK' : `falta: ${missing.join(', ')}`,
    };
  };

  return [
    check('001_commerce_core', [
      { kind: 'table', name: 'customers' },
      { kind: 'table', name: 'orders' },
      { kind: 'table', name: 'order_items' },
      { kind: 'table', name: 'inventory' },
      { kind: 'table', name: 'inventory_movements' },
      { kind: 'table', name: 'pickup_codes' },
      { kind: 'table', name: 'order_status_transitions' },
      { kind: 'table', name: 'order_status_history' },
      { kind: 'function', name: 'inventory_apply_movement' },
      { kind: 'function', name: 'inventory_reserve_order' },
      { kind: 'function', name: 'enforce_order_status_transition' },
    ]),
    check('002_payment_confirmation', [
      { kind: 'function', name: 'confirm_order_payment' },
      { kind: 'function', name: 'inventory_rereserve_order' },
      {
        kind: 'marker',
        ok: input.hasExpiredToConfirmed,
        name: "transición 'expired' → 'confirmed'",
      },
    ]),
    check('003_pickup_pin_kiosk', [
      { kind: 'table', name: 'pickup_attempts' },
      { kind: 'function', name: 'redeem_pickup_code_verified' },
      { kind: 'function', name: 'mark_order_ready_for_pickup' },
    ]),
    check('004_payment_webhook_diagnostics', [
      { kind: 'table', name: 'payment_webhook_events' },
    ]),
    check('005_duplicate_payment_guard', [
      { kind: 'marker', ok: input.markers.duplicatePaymentGuard, name: 'guarda duplicatePayment en confirm_order_payment' },
    ]),
    check('006_fulfillment_stock_conflict_guard', [
      { kind: 'marker', ok: input.markers.fulfillmentReadyGuard, name: 'guarda en mark_order_ready_for_pickup' },
      { kind: 'marker', ok: input.markers.fulfillmentCommitGuard, name: 'guarda en inventory_commit_order' },
      { kind: 'marker', ok: input.markers.fulfillmentPickupGuard, name: 'guarda en redeem_pickup_code_verified' },
    ]),
    check('007_release_respects_rereservation', [
      { kind: 'marker', ok: input.markers.releaseRereservation, name: 'predicado prior_releases en inventory_release_order' },
    ]),
  ];
}

/** Tablas de negocio cuyo conteo se pide por defecto. */
export const KEY_TABLES = [
  'customers',
  'orders',
  'order_items',
  'inventory',
  'inventory_movements',
  'pickup_codes',
  'pickup_attempts',
  'order_status_transitions',
  'order_status_history',
  'product_overrides',
  'categories',
  'brands',
  'payment_webhook_events',
] as const;

/** Parser de argumentos. Falla cerrado ante valores desconocidos. */
export function parseArgs(argv: string[]): AuditOptions {
  let json = false;
  let counts: CountMode = 'key';

  for (const arg of argv) {
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg.startsWith('--counts=')) {
      const value = arg.slice('--counts='.length);
      if (value !== 'key' && value !== 'all' && value !== 'skip') {
        throw new Error(`audit_schema: invalid --counts value (${value})`);
      }
      counts = value;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      continue;
    }
    throw new Error(`audit_schema: unknown argument (${arg})`);
  }

  return { json, counts };
}

// =============================================================================
//  ACCESO A LA BASE (sólo SELECT)
// =============================================================================

function asString(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 't' || value === 'true';
}

async function selectRows<T>(client: Client, sql: string): Promise<T[]> {
  const safe = assertReadOnlySql(sql);
  const result = await client.query(safe);
  return result.rows as T[];
}

function resolveConnectionString(env: NodeJS.ProcessEnv): string | undefined {
  return (
    env.AUDIT_DATABASE_URL ||
    env.POSTGRES_URL_NON_POOLING ||
    env.POSTGRES_URL ||
    env.DATABASE_URL ||
    undefined
  );
}

/** Lee el catálogo dentro de una transacción READ ONLY. */
async function buildSnapshot(client: Client): Promise<SchemaSnapshot> {
  const versionRows = await selectRows<Row>(
    client,
    `SELECT version() AS version, current_database() AS database`,
  );
  const serverVersion = asString(versionRows[0]?.version);
  const database = asString(versionRows[0]?.database);

  const tableRows = await selectRows<Row>(
    client,
    `SELECT table_name, table_type
       FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name`,
  );
  const tables = tableRows.map((row) => ({
    name: asString(row.table_name),
    type: asString(row.table_type),
  }));

  const columnRows = await selectRows<Row>(
    client,
    `SELECT table_name, column_name, data_type, udt_name, is_nullable,
            column_default, is_generated
       FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position`,
  );
  const columns: ColumnSnapshot[] = columnRows.map((row) => ({
    table: asString(row.table_name),
    column: asString(row.column_name),
    dataType: asString(row.data_type),
    udtName: asString(row.udt_name),
    nullable: asString(row.is_nullable).toUpperCase() === 'YES',
    default: row.column_default == null ? null : normalizeDefinition(asString(row.column_default)),
    generated: asString(row.is_generated).toUpperCase() === 'ALWAYS',
  }));

  const constraintRows = await selectRows<Row>(
    client,
    `SELECT c.relname AS table_name,
            con.conname AS name,
            con.contype AS type,
            pg_get_constraintdef(con.oid) AS definition
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
      ORDER BY c.relname, con.conname`,
  );
  const constraints: ConstraintSnapshot[] = constraintRows.map((row) => ({
    table: asString(row.table_name),
    name: asString(row.name),
    type: asString(row.type),
    definition: normalizeDefinition(asString(row.definition)),
  }));

  const indexRows = await selectRows<Row>(
    client,
    `SELECT tablename AS table_name, indexname AS name, indexdef AS definition
       FROM pg_indexes
      WHERE schemaname = 'public'
      ORDER BY tablename, indexname`,
  );
  const indexes: IndexSnapshot[] = indexRows.map((row) => ({
    table: asString(row.table_name),
    name: asString(row.name),
    definition: normalizeDefinition(asString(row.definition)),
  }));

  const functionRows = await selectRows<Row>(
    client,
    `SELECT p.proname AS name,
            pg_get_function_identity_arguments(p.oid) AS args,
            pg_get_function_result(p.oid) AS returns,
            l.lanname AS language,
            md5(pg_get_functiondef(p.oid)) AS body_hash
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_language l ON l.oid = p.prolang
      WHERE n.nspname = 'public'
        AND p.prokind = 'f'
      ORDER BY p.proname, args`,
  );
  const functions: FunctionSnapshot[] = functionRows.map((row) => ({
    name: asString(row.name),
    args: asString(row.args),
    returns: asString(row.returns),
    language: asString(row.language),
    bodyHash: asString(row.body_hash),
  }));

  const triggerRows = await selectRows<Row>(
    client,
    `SELECT c.relname AS table_name,
            t.tgname AS name,
            pg_get_triggerdef(t.oid) AS definition
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND NOT t.tgisinternal
      ORDER BY c.relname, t.tgname`,
  );
  const triggers: TriggerSnapshot[] = triggerRows.map((row) => ({
    table: asString(row.table_name),
    name: asString(row.name),
    definition: normalizeDefinition(asString(row.definition)),
  }));

  // La tabla de transiciones puede no existir en una base vacía (p. ej. el
  // PostgreSQL recién creado de Railway). Sin un SAVEPOINT, el error abortaría
  // TODA la transacción READ ONLY y las consultas siguientes fallarían con
  // "current transaction is aborted".
  let hasExpiredToConfirmed = false;
  try {
    await client.query('SAVEPOINT audit_schema_transitions');
    const transitionRows = await selectRows<Row>(
      client,
      `SELECT count(*) FILTER (
                WHERE from_status = 'expired' AND to_status = 'confirmed'
              )::bigint AS expired_to_confirmed
         FROM order_status_transitions`,
    );
    hasExpiredToConfirmed = Number(transitionRows[0]?.expired_to_confirmed ?? 0) > 0;
    await client.query('RELEASE SAVEPOINT audit_schema_transitions');
  } catch {
    hasExpiredToConfirmed = false;
    try {
      await client.query('ROLLBACK TO SAVEPOINT audit_schema_transitions');
    } catch {
      /* el SAVEPOINT no llegó a crearse: la transacción sigue utilizable */
    }
  }

  // Marcadores de cuerpo de función: identifican 005, 006 y 007 sin imprimir código.
  const markerRows = await selectRows<Row>(
    client,
    `SELECT
       CASE WHEN to_regprocedure('confirm_order_payment(text,text,text,numeric,text,jsonb,text,text)') IS NULL
            THEN false
            ELSE position('duplicatePayment' IN pg_get_functiondef(
                   to_regprocedure('confirm_order_payment(text,text,text,numeric,text,jsonb,text,text)'))) > 0
       END AS duplicate_payment_guard,
       CASE WHEN to_regprocedure('mark_order_ready_for_pickup(uuid,text,text,interval,integer,text)') IS NULL
            THEN false
            ELSE position('order_requires_review' IN pg_get_functiondef(
                   to_regprocedure('mark_order_ready_for_pickup(uuid,text,text,interval,integer,text)'))) > 0
       END AS fulfillment_ready_guard,
       CASE WHEN to_regprocedure('inventory_commit_order(uuid,text)') IS NULL
            THEN false
            ELSE position('order_requires_review' IN pg_get_functiondef(
                   to_regprocedure('inventory_commit_order(uuid,text)'))) > 0
       END AS fulfillment_commit_guard,
       CASE WHEN to_regprocedure('redeem_pickup_code_verified(text,text,text,text)') IS NULL
            THEN false
            ELSE position('order_requires_review' IN pg_get_functiondef(
                   to_regprocedure('redeem_pickup_code_verified(text,text,text,text)'))) > 0
       END AS fulfillment_pickup_guard,
       CASE WHEN to_regprocedure('inventory_release_order(uuid,text)') IS NULL
            THEN false
            ELSE position('prior_releases' IN pg_get_functiondef(
                   to_regprocedure('inventory_release_order(uuid,text)'))) > 0
       END AS release_rereservation`,
  );
  const markerRow = markerRows[0] ?? {};
  const markers: MigrationMarkers = {
    duplicatePaymentGuard: asBoolean(markerRow.duplicate_payment_guard),
    fulfillmentReadyGuard: asBoolean(markerRow.fulfillment_ready_guard),
    fulfillmentCommitGuard: asBoolean(markerRow.fulfillment_commit_guard),
    fulfillmentPickupGuard: asBoolean(markerRow.fulfillment_pickup_guard),
    releaseRereservation: asBoolean(markerRow.release_rereservation),
  };

  const expected = evaluateExpectedMigrations({
    tables: tables.map((table) => table.name),
    functions: functions.map((fn) => fn.name),
    hasExpiredToConfirmed,
    markers,
  });

  const snapshot: SchemaSnapshot = {
    serverVersion,
    database,
    tables,
    columns,
    constraints,
    indexes,
    functions,
    triggers,
    expected,
  };

  return snapshot;
}

/** Conteos exactos. `key` limita a las tablas de negocio; `all` recorre todo. */
async function collectCounts(
  client: Client,
  tables: Array<{ name: string; type: string }>,
  mode: CountMode,
): Promise<TableCount[]> {
  if (mode === 'skip') return [];

  const available = new Set(
    tables.filter((table) => table.type === 'BASE TABLE').map((table) => table.name),
  );
  const requested =
    mode === 'all'
      ? [...available].sort()
      : KEY_TABLES.filter((table) => available.has(table));

  const counts: TableCount[] = [];
  for (const table of requested) {
    let savepoint = false;
    try {
      await client.query('SAVEPOINT audit_schema_count');
      savepoint = true;
      const rows = await selectRows<Row>(
        client,
        `SELECT count(*)::bigint AS n FROM "public".${quoteIdentifier(table)}`,
      );
      counts.push({ table, rows: Number(rows[0]?.n ?? 0) });
      await client.query('RELEASE SAVEPOINT audit_schema_count');
    } catch (error) {
      if (savepoint) {
        try {
          await client.query('ROLLBACK TO SAVEPOINT audit_schema_count');
        } catch {
          /* la transacción ya estaba abortada: el error original es el útil */
        }
      }
      counts.push({
        table,
        rows: null,
        error: redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 160),
      });
    }
  }

  if (mode === 'key') {
    for (const table of KEY_TABLES) {
      if (!available.has(table)) counts.push({ table, rows: null, error: 'no existe' });
    }
  }

  return counts;
}

/** Ejecuta la auditoría completa contra una connection string. */
export async function auditSchema(connectionString: string, counts: CountMode): Promise<AuditResult> {
  const client = new Client({
    connectionString,
    application_name: 'umantai-audit-schema',
    statement_timeout: 20_000,
  });

  await client.connect();
  try {
    // Garantía a nivel de PostgreSQL: cualquier escritura falla con 25006.
    await client.query('BEGIN READ ONLY');
    const snapshot = await buildSnapshot(client);
    const tableCounts = await collectCounts(client, snapshot.tables, counts);
    await client.query('ROLLBACK');

    const fingerprint = fingerprintSchema(snapshot);

    return { target: describeTarget(connectionString), fingerprint, snapshot, counts: tableCounts };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* la conexión pudo haberse cerrado */
    }
    throw error;
  } finally {
    await client.end();
  }
}

// =============================================================================
//  SALIDA
// =============================================================================

function printHuman(result: AuditResult): void {
  const { snapshot } = result;

  console.log('Umantai — auditoría de esquema (READ ONLY)');
  console.log(`Target:      ${result.target}`);
  console.log(`PostgreSQL:  ${snapshot.serverVersion}`);
  console.log(`Database:    ${snapshot.database}`);
  console.log(`Fingerprint: ${result.fingerprint}`);
  console.log('');

  console.log(`Tablas (${snapshot.tables.length}):`);
  for (const table of snapshot.tables) {
    console.log(`  - ${table.name} [${table.type}]`);
  }
  console.log('');

  if (result.counts.length > 0) {
    console.log('Conteos:');
    for (const count of result.counts) {
      const value = count.error ? `ERROR (${count.error})` : count.rows;
      console.log(`  - ${count.table}: ${value}`);
    }
    console.log('');
  }

  console.log(`Funciones (${snapshot.functions.length}):`);
  for (const fn of snapshot.functions) {
    console.log(
      `  - ${fn.name}(${fn.args}) -> ${fn.returns} [${fn.language}] #${fn.bodyHash.slice(0, 12)}`,
    );
  }
  console.log('');

  console.log(`Triggers (${snapshot.triggers.length}):`);
  for (const trigger of snapshot.triggers) {
    console.log(`  - ${trigger.table}.${trigger.name}`);
  }
  console.log('');

  console.log(`Índices (${snapshot.indexes.length}):`);
  for (const index of snapshot.indexes) {
    console.log(`  - ${index.table}.${index.name}`);
  }
  console.log('');

  console.log(`Constraints (${snapshot.constraints.length}):`);
  for (const constraint of snapshot.constraints) {
    console.log(`  - ${constraint.table}.${constraint.name} [${constraint.type}]`);
  }
  console.log('');

  console.log('Migraciones esperadas 001–007:');
  for (const check of snapshot.expected) {
    console.log(`  ${check.present ? 'OK   ' : 'FALTA'} ${check.id} — ${check.detail}`);
  }
}

function printHelp(): void {
  console.log('Uso: node --import tsx scripts/audit-schema.ts [--json] [--counts=key|all|skip]');
  console.log('');
  console.log('Conexión (en orden): AUDIT_DATABASE_URL, POSTGRES_URL_NON_POOLING, POSTGRES_URL, DATABASE_URL');
  console.log('El script abre una transacción READ ONLY y no imprime credenciales.');
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return;
  }

  const options = parseArgs(argv);
  const connectionString = resolveConnectionString(process.env);
  if (!connectionString) {
    console.error(
      'audit_schema: no database URL. Define AUDIT_DATABASE_URL (preferida) o POSTGRES_URL_NON_POOLING.',
    );
    process.exitCode = 1;
    return;
  }

  try {
    const result = await auditSchema(connectionString, options.counts);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printHuman(result);
    }
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    console.error(`audit_schema: ${message}`);
    process.exitCode = 2;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath && invokedPath === import.meta.url) {
  void main(process.argv.slice(2));
}
