/**
 * tests/complaints.integration.test.ts — Libro de Reclamaciones contra PostgreSQL.
 *
 * Base efímera local (o INTEGRATION_DATABASE_URL de test), migración 023.
 * Cubre: correlativo, código público opaco, consulta sin PII, filtros, revisión,
 * respuesta única, XSS como dato y autorización estricta de las rutas admin.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import { closeDbPools } from '../lib/db-driver.server';
import type { ComplaintInput } from '../lib/complaints';
import { startTestDatabase, type EmbeddedTestDatabase } from './helpers/embedded-postgres';

type ComplaintsServer = typeof import('../lib/complaints.server');
type PlatformAdmin = typeof import('../lib/platform-admin.server');
type ListRoute = typeof import('../app/api/admin/complaints/route');
type DetailRoute = typeof import('../app/api/admin/complaints/[id]/route');

let database: EmbeddedTestDatabase;
let complaints: ComplaintsServer;
let platformAdmin: PlatformAdmin;
let listRoute: ListRoute;
let detailRoute: DetailRoute;

const ADMIN_SECRET = 'integration-platform-admin-secret-0123456789';

function input(overrides: Partial<ComplaintInput> = {}): ComplaintInput {
  return {
    kind: 'reclamo',
    consumerName: 'Ana Pérez',
    consumerDocument: '12345678',
    consumerPhone: '+51 999 888 777',
    consumerEmail: 'ana@example.com',
    isMinor: false,
    guardianName: null,
    guardianDocument: null,
    relatedItem: 'Pedido UM-000123',
    amountCents: 1250,
    detail: 'El producto llegó vencido y no coincide con lo anunciado.',
    consumerRequest: 'Solicito el cambio del producto o la devolución del monto.',
    ...overrides,
  };
}

function adminRequest(method = 'GET', body?: unknown, token?: string): Request {
  const headers: Record<string, string> = {
    cookie: `umantai_platform_admin=${token ?? createToken()}`,
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new Request('http://localhost/api/admin/complaints', {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function createToken(): string {
  const token = platformAdmin.createPlatformAdminToken('user-integration');
  assert.ok(token, 'no se pudo firmar la cookie de admin');
  return token;
}

before(async () => {
  database = await startTestDatabase();

  process.env.DB_DRIVER = 'pg';
  process.env.POSTGRES_URL_NON_POOLING = database.url;
  process.env.APP_ENV = 'test';
  process.env.PLATFORM_ADMIN_SECRET = ADMIN_SECRET;
  delete process.env.VERCEL_ENV;
  delete process.env.RESEND_API_KEY;

  complaints = await import('../lib/complaints.server');
  platformAdmin = await import('../lib/platform-admin.server');
  listRoute = await import('../app/api/admin/complaints/route');
  detailRoute = await import('../app/api/admin/complaints/[id]/route');
});

after(async () => {
  await closeDbPools();
  if (database) await database.stop();
});

test('registra el reclamo con correlativo y código público no secuencial', async () => {
  const created = await complaints.createComplaint(input());

  assert.match(created.complaintNumber, /^RC-\d{6}$/);
  assert.equal(created.complaintNumber, 'RC-000001');
  assert.match(created.publicCode, /^[A-Za-z0-9_-]{24}$/);
  assert.notEqual(created.publicCode, created.complaintNumber);
  assert.ok(new Date(created.dueAt).getTime() > new Date(created.submittedAt).getTime());
  assert.equal(await complaints.countComplaints(), 1);
});

test('la consulta pública no expone DNI, teléfono ni correo', async () => {
  const created = await complaints.createComplaint(input());
  const view = await complaints.getComplaintByPublicCode(created.publicCode);

  assert.ok(view);
  assert.equal(view.complaintNumber, created.complaintNumber);
  assert.equal(view.relatedItem, 'Pedido UM-000123');
  assert.equal(view.amountCents, 1250);
  assert.equal(view.overdue, false);

  const keys = Object.keys(view);
  for (const forbidden of ['consumerEmail', 'consumerPhone', 'consumerDocument', 'consumerName']) {
    assert.ok(!keys.includes(forbidden), `la vista pública expone ${forbidden}`);
  }
});

test('el correlativo avanza y el código desconocido no filtra existencia', async () => {
  const first = await complaints.createComplaint(input());
  const second = await complaints.createComplaint(input());

  const firstNumber = Number(first.complaintNumber.replace(/\D/g, ''));
  const secondNumber = Number(second.complaintNumber.replace(/\D/g, ''));
  assert.equal(secondNumber, firstNumber + 1);
  assert.notEqual(first.publicCode, second.publicCode);

  assert.equal(await complaints.getComplaintByPublicCode('Z'.repeat(24)), null);
  assert.equal(await complaints.getComplaintByPublicCode('RC-000001'), null);
});

test('filtra por estado, tipo y rango de fechas', async () => {
  await complaints.createComplaint(input({ kind: 'queja', relatedItem: 'Atención en tienda' }), new Date('2026-01-05T15:00:00Z'));
  await complaints.createComplaint(input({ kind: 'reclamo' }), new Date('2026-02-10T15:00:00Z'));

  const quejas = await complaints.listComplaints({ kind: 'queja', limit: 50 });
  assert.ok(quejas.length >= 1);
  assert.ok(quejas.every((row) => row.kind === 'queja'));

  const january = await complaints.listComplaints({
    from: '2026-01-01',
    to: '2026-01-31',
    limit: 50,
  });
  assert.ok(january.length >= 1);
  assert.ok(january.every((row) => row.submittedAt.startsWith('2026-01')));

  const received = await complaints.listComplaints({ status: 'received', limit: 50 });
  assert.ok(received.length >= 1);
  assert.ok(received.every((row) => row.status === 'received'));
});

test('pasa a revisión y registra una única respuesta', async () => {
  const created = await complaints.createComplaint(input());

  const inReview = await complaints.markComplaintInReview(created.id);
  assert.ok(inReview);
  assert.equal(inReview.status, 'in_review');

  const answered = await complaints.answerComplaint(created.id, {
    responseText: 'Aprobamos el cambio y coordinamos la entrega con el cliente.',
    providerActions: 'Se verificó el lote con el proveedor.',
  });
  assert.ok(answered);
  assert.equal(answered.status, 'answered');
  assert.ok(answered.respondedAt);
  assert.match(answered.responseText ?? '', /Aprobamos el cambio/);
  assert.equal(answered.providerActions, 'Se verificó el lote con el proveedor.');
  assert.equal(answered.overdue, false);

  // El historial no se sobrescribe.
  const second = await complaints.answerComplaint(created.id, {
    responseText: 'Otra respuesta distinta que no debería reemplazar la primera.',
  });
  assert.equal(second, null);
});

test('XSS: el contenido se guarda como texto y se devuelve tal cual', async () => {
  const payload = '<script>alert(1)</script>';
  const created = await complaints.createComplaint(
    input({ detail: `Detalle con ${payload} y suficiente longitud para pasar.` }),
  );

  const view = await complaints.getComplaintByPublicCode(created.publicCode);
  assert.ok(view);
  assert.ok(view.detail.includes(payload));
  // El HTML se escapa al renderizar (React); la base no interpreta nada.
});

test('admin: exige sesión de Platform Admin, no acepta solo token', async () => {
  const withoutCookie = await listRoute.GET(new Request('http://localhost/api/admin/complaints'));
  assert.equal(withoutCookie.status, 401);

  const tokenOnly = await listRoute.GET(
    new Request('http://localhost/api/admin/complaints', {
      headers: { 'x-admin-token': ADMIN_SECRET },
    }),
  );
  assert.equal(tokenOnly.status, 401);

  const authorized = await listRoute.GET(adminRequest());
  assert.equal(authorized.status, 200);
  const payload = (await authorized.json()) as { ok: boolean; complaints: unknown[] };
  assert.equal(payload.ok, true);
  assert.ok(Array.isArray(payload.complaints));
});

test('admin: lista, detalle, validación y respuesta; sin DELETE', async () => {
  const created = await complaints.createComplaint(input({ relatedItem: 'Detalle admin' }));

  const detail = await detailRoute.GET(adminRequest(), {
    params: Promise.resolve({ id: created.id }),
  });
  assert.equal(detail.status, 200);
  const detailPayload = (await detail.json()) as {
    complaint: { consumerDocument: string; consumerEmail: string };
  };
  assert.equal(detailPayload.complaint.consumerDocument, '12345678');
  assert.equal(detailPayload.complaint.consumerEmail, 'ana@example.com');

  const badAnswer = await detailRoute.PATCH(adminRequest('PATCH', { action: 'answer', responseText: '' }), {
    params: Promise.resolve({ id: created.id }),
  });
  assert.equal(badAnswer.status, 400);

  const answer = await detailRoute.PATCH(
    adminRequest('PATCH', {
      action: 'answer',
      responseText: 'Respondemos dentro del plazo con el cambio solicitado.',
    }),
    { params: Promise.resolve({ id: created.id }) },
  );
  assert.equal(answer.status, 200);
  const answerPayload = (await answer.json()) as { complaint: { status: string }; emailStatus: string };
  assert.equal(answerPayload.complaint.status, 'answered');
  // Sin RESEND_API_KEY no se finge un envío.
  assert.equal(answerPayload.emailStatus, 'not_configured');

  const again = await detailRoute.PATCH(
    adminRequest('PATCH', {
      action: 'answer',
      responseText: 'Segunda respuesta que no debe sobrescribir la primera.',
    }),
    { params: Promise.resolve({ id: created.id }) },
  );
  assert.equal(again.status, 409);

  const missing = await detailRoute.GET(adminRequest(), {
    params: Promise.resolve({ id: '00000000-0000-4000-8000-000000000000' }),
  });
  assert.equal(missing.status, 404);

  assert.equal((detailRoute as Record<string, unknown>).DELETE, undefined);
});

test('admin: filtros inválidos devuelven 400 sin tocar datos', async () => {
  const badStatus = await listRoute.GET(
    new Request('http://localhost/api/admin/complaints?status=borrado', {
      headers: { cookie: `umantai_platform_admin=${createToken()}` },
    }),
  );
  assert.equal(badStatus.status, 400);

  const badRange = await listRoute.GET(
    new Request('http://localhost/api/admin/complaints?from=2026-02-01&to=2026-01-01', {
      headers: { cookie: `umantai_platform_admin=${createToken()}` },
    }),
  );
  assert.equal(badRange.status, 400);
});
