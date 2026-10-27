/**
 * tests/platform-admin-revocation.integration.test.ts — revocación EFECTIVA.
 *
 * Antes, borrar la fila de `platform_admins` no invalidaba una cookie ya emitida
 * (seguía sirviendo hasta 8 h). Ahora cada petición protegida revalida el rol
 * contra la base, así que la MISMA cookie deja de autorizar en el acto.
 *
 * Corre contra PostgreSQL efímero (migraciones 001–024) y ejercita los handlers
 * reales: la bandeja de reclamaciones, inventario (puerta compartida) y el
 * endpoint de estado de la sesión de admin.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

import { closeDbPools } from '../lib/db-driver.server';
import { startTestDatabase, type EmbeddedTestDatabase } from './helpers/embedded-postgres';

const SECRET = 'integration-platform-admin-secret-0123456789';
const ADMIN_TOKEN = 'integration-shared-admin-token';

/** Los handlers reales esperan `NextRequest`; en el test alcanza con `Request`. */
type RouteHandler = (request: Request) => Promise<Response>;

let database: EmbeddedTestDatabase;
let db: Client;
let complaintsGet: RouteHandler;
let inventoryGet: RouteHandler;
let sessionGet: RouteHandler;
let createToken: (userId: string) => string | null;
let cookieName: string;

function cookieFor(userId: string): string {
  const token = createToken(userId);
  assert.ok(token, 'debe poder firmarse una cookie de admin');
  return `${cookieName}=${encodeURIComponent(token as string)}`;
}

async function createUser(email: string): Promise<string> {
  const id = randomUUID();
  await db.query(
    'INSERT INTO users (id, name, email, "emailVerified") VALUES ($1, $2, $3, TRUE)',
    [id, 'Integration Admin', email],
  );
  return id;
}

async function grant(userId: string): Promise<void> {
  await db.query('INSERT INTO platform_admins (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [
    userId,
  ]);
}

async function revoke(userId: string): Promise<void> {
  await db.query('DELETE FROM platform_admins WHERE user_id = $1', [userId]);
}

function adminRequest(path: string, cookie?: string, withToken = false): Request {
  const url = new URL(`https://staging.example.com${path}`);
  const request = new Request(url, {
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(withToken ? { 'x-admin-token': ADMIN_TOKEN } : {}),
    },
  });
  // `NextRequest` añade `nextUrl`; se replica para los handlers que lo leen.
  Object.defineProperty(request, 'nextUrl', { value: url, configurable: true });
  return request;
}

before(async () => {
  database = await startTestDatabase();

  process.env.DB_DRIVER = 'pg';
  process.env.POSTGRES_URL_NON_POOLING = database.url;
  process.env.POSTGRES_URL = database.url;
  process.env.APP_ENV = 'test';
  process.env.PLATFORM_ADMIN_SECRET = SECRET;
  process.env.ADMIN_API_SECRET = ADMIN_TOKEN;
  delete process.env.PLATFORM_ADMIN_EMAILS; // el bootstrap no debe enmascarar la revocación

  const platformAdmin = await import('../lib/platform-admin.server');
  createToken = platformAdmin.createPlatformAdminToken;
  cookieName = platformAdmin.PLATFORM_ADMIN_COOKIE;

  complaintsGet = (await import('../app/api/admin/complaints/route')).GET as unknown as RouteHandler;
  inventoryGet = (await import('../app/api/admin/inventory/route')).GET as unknown as RouteHandler;
  sessionGet = (await import('../app/api/admin/session/route')).GET as unknown as RouteHandler;

  db = new Client({ connectionString: database.url });
  await db.connect();
});

after(async () => {
  if (db) await db.end().catch(() => undefined);
  await closeDbPools();
  if (database) await database.stop();
});

test('grant activo → la misma cookie autoriza (200)', async () => {
  const userId = await createUser('admin-activo@integration.test');
  await grant(userId);
  const cookie = cookieFor(userId);

  const complaints = await complaintsGet(adminRequest('/api/admin/complaints', cookie));
  assert.equal(complaints.status, 200);

  const inventory = await inventoryGet(adminRequest('/api/admin/inventory', cookie));
  assert.equal(inventory.status, 200);

  const session = await sessionGet(adminRequest('/api/admin/session', cookie));
  const sessionBody = (await session.json()) as { authenticated?: boolean };
  assert.equal(sessionBody.authenticated, true);
});

test('revocar el grant deniega la MISMA cookie de inmediato', async () => {
  const userId = await createUser('admin-revocado@integration.test');
  await grant(userId);
  const cookie = cookieFor(userId);

  assert.equal((await complaintsGet(adminRequest('/api/admin/complaints', cookie))).status, 200);
  assert.equal((await inventoryGet(adminRequest('/api/admin/inventory', cookie))).status, 200);

  await revoke(userId);

  const complaints = await complaintsGet(adminRequest('/api/admin/complaints', cookie));
  assert.equal(complaints.status, 403);
  const body = (await complaints.json()) as { ok?: boolean; code?: string; error?: string };
  assert.equal(body.ok, false);
  assert.equal(body.code, 'admin_grant_inactive');
  assert.ok((body.error ?? '').length > 0);

  // La puerta compartida (inventario, pedidos, planes…) también cae sin tocar
  // su código: todas pasan por el mismo `requireAdminAccess`.
  assert.equal((await inventoryGet(adminRequest('/api/admin/inventory', cookie))).status, 403);

  // El endpoint de estado deja de reportarse autenticado y descarta la cookie.
  const session = await sessionGet(adminRequest('/api/admin/session', cookie));
  const sessionBody = (await session.json()) as { authenticated?: boolean; revoked?: boolean };
  assert.equal(sessionBody.authenticated, false);
  assert.equal(sessionBody.revoked, true);
  assert.match(session.headers.get('set-cookie') ?? '', /umantai_platform_admin=;|umantai_platform_admin=$/);
});

test('usuario sin rol (nunca autorizado) → 403', async () => {
  const userId = await createUser('usuario-normal@integration.test');
  const cookie = cookieFor(userId);

  const response = await complaintsGet(adminRequest('/api/admin/complaints', cookie));
  assert.equal(response.status, 403);
  const body = (await response.json()) as { code?: string };
  assert.equal(body.code, 'admin_grant_inactive');
});

test('cuenta borrada con cookie válida → 403', async () => {
  const userId = await createUser('cuenta-borrada@integration.test');
  await grant(userId);
  const cookie = cookieFor(userId);
  assert.equal((await complaintsGet(adminRequest('/api/admin/complaints', cookie))).status, 200);

  await db.query('DELETE FROM platform_admins WHERE user_id = $1', [userId]);
  await db.query('DELETE FROM users WHERE id = $1', [userId]);

  assert.equal((await complaintsGet(adminRequest('/api/admin/complaints', cookie))).status, 403);
});

test('cookie falsificada → 401', async () => {
  const forged = `${cookieName}=${encodeURIComponent('payload.firma-invalida')}`;
  const response = await complaintsGet(adminRequest('/api/admin/complaints', forged));
  assert.equal(response.status, 401);
  const body = (await response.json()) as { code?: string };
  assert.equal(body.code, 'admin_session_required');
});

test('sin cookie ni token → 401 (el token compartido no se puede omitir)', async () => {
  const response = await complaintsGet(adminRequest('/api/admin/complaints'));
  assert.equal(response.status, 401);
  const body = (await response.json()) as { code?: string };
  assert.equal(body.code, 'admin_session_required');
});

test('el token compartido (automatización) sigue funcionando', async () => {
  const response = await inventoryGet(adminRequest('/api/admin/inventory', undefined, true));
  assert.equal(response.status, 200);
});

test('la bandeja de reclamaciones no acepta el token compartido', async () => {
  // Acá se leen DNI, teléfonos y correos: exige rol vigente, no un token de CI.
  const response = await complaintsGet(adminRequest('/api/admin/complaints', undefined, true));
  assert.equal(response.status, 401);
});
