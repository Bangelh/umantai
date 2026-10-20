import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyError,
  logError,
  logRequest,
  sanitizeFields,
} from '../lib/observability.server';

function capture(run: () => void): string[] {
  const lines: string[] = [];
  const original = {
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  console.info = (line: unknown) => void lines.push(String(line));
  console.warn = (line: unknown) => void lines.push(String(line));
  console.error = (line: unknown) => void lines.push(String(line));
  try {
    run();
  } finally {
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
  }
  return lines;
}

function request(headers: Record<string, string> = {}): Request {
  return new Request('https://example.test/api/orders', {
    method: 'POST',
    headers,
  });
}

test('logRequest emite una línea JSON con los campos exigidos', () => {
  const [line] = capture(() =>
    logRequest({
      request: request({ 'x-request-id': 'req-123' }),
      route: '/api/orders',
      status: 201,
      durationMs: 42.6,
    }),
  );
  const payload = JSON.parse(line);
  assert.equal(payload.event, 'request_completed');
  assert.equal(payload.requestId, 'req-123');
  assert.equal(payload.route, '/api/orders');
  assert.equal(payload.method, 'POST');
  assert.equal(payload.durationMs, 43);
  assert.equal(payload.result, 'ok');
  assert.ok(payload.environment);
  assert.ok(payload.ts);
});

test('un 5xx se marca como error con categoría segura', () => {
  const [line] = capture(() =>
    logRequest({
      request: request({ 'x-request-id': 'req-500' }),
      route: '/api/search',
      status: 503,
      durationMs: 10,
      error: Object.assign(new Error('connection refused to db-host'), { code: 'ECONNREFUSED' }),
    }),
  );
  const payload = JSON.parse(line);
  assert.equal(payload.level, 'error');
  assert.equal(payload.result, 'error');
  assert.equal(payload.errorCategory, 'database_unavailable');
  assert.doesNotMatch(line, /db-host/);
});

test('sanitizeFields elimina secretos, documentos y geolocalización', () => {
  const clean = sanitizeFields({
    password: 'hunter2',
    accessToken: 'abc',
    authorization: 'Bearer xyz',
    cookie: 'session=1',
    docNumber: '12345678',
    latitude: -12.0464,
    longitude: -77.0428,
    route: '/api/orders',
    status: 200,
  });
  assert.deepEqual(clean, { route: '/api/orders', status: 200 });
});

test('strings largos se truncan', () => {
  const clean = sanitizeFields({ note: 'x'.repeat(500) });
  assert.ok(String(clean.note).length <= 301);
});

test('logError nunca emite contraseña ni documento', () => {
  const [line] = capture(() =>
    logError('checkout_failed', new Error('boom'), {
      password: 'secret',
      docNumber: '123',
      requestId: 'req-9',
    }),
  );
  assert.doesNotMatch(line, /secret/);
  assert.doesNotMatch(line, /123/);
  assert.equal(JSON.parse(line).errorCategory, 'internal');
});

test('classifyError reconoce RLS, unicidad y auth', () => {
  assert.equal(classifyError({ code: '42501' }), 'forbidden_rls');
  assert.equal(classifyError({ code: '23505' }), 'conflict_unique');
  assert.equal(classifyError({ code: 'not_authenticated' }), 'auth');
  assert.equal(classifyError(null), 'unknown');
});
