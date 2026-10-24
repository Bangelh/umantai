/**
 * tests/complaints.test.ts — Libro de Reclamaciones: dominio puro.
 *
 * Lo que se fija acá:
 *   · validación server-side (campos, límites, menores, monto);
 *   · normalización y honeypot;
 *   · cálculo de 15 días hábiles en hora de Lima (sin feriados);
 *   · código público no secuencial y número correlativo.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPLAINT_RESPONSE_BUSINESS_DAYS,
  addBusinessDaysLima,
  complaintDueAt,
  formatComplaintNumber,
  isComplaintOverdue,
  isValidPublicCode,
  validateComplaintPayload,
  validateComplaintResponse,
} from '../lib/complaints';

const VALID = {
  kind: 'reclamo',
  consumerName: '  Ana   Pérez  ',
  consumerDocument: ' 12345678 ',
  consumerPhone: '+51 999 888 777',
  consumerEmail: 'ANA@Example.COM',
  isMinor: false,
  guardianName: '',
  guardianDocument: '',
  relatedItem: 'Pedido UM-000123, arroz 5 kg',
  amountCents: '12.50',
  detail: 'El producto llegó vencido y no coincide con lo anunciado en la tienda.',
  consumerRequest: 'Solicito el cambio del producto o la devolución del monto pagado.',
  consent: true,
  company: '',
};

test('payload válido: normaliza nombre, documento, correo y monto', () => {
  const result = validateComplaintPayload(VALID);
  assert.ok(result.ok);
  assert.equal(result.value.consumerName, 'Ana Pérez');
  assert.equal(result.value.consumerDocument, '12345678');
  assert.equal(result.value.consumerEmail, 'ana@example.com');
  assert.equal(result.value.amountCents, 1250);
  assert.equal(result.value.kind, 'reclamo');
  assert.equal(result.value.guardianName, null);
});

test('monto opcional y con coma decimal', () => {
  const empty = validateComplaintPayload({ ...VALID, amountCents: '' });
  assert.ok(empty.ok);
  assert.equal(empty.value.amountCents, null);

  const comma = validateComplaintPayload({ ...VALID, amountCents: '12,5' });
  assert.ok(comma.ok);
  assert.equal(comma.value.amountCents, 1250);
});

test('campos obligatorios: se devuelven códigos por campo, no textos', () => {
  const result = validateComplaintPayload({
    kind: 'otro',
    consumerName: '',
    consumerDocument: '',
    consumerPhone: '',
    consumerEmail: '',
    relatedItem: '',
    detail: '',
    consumerRequest: '',
    consent: false,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errors.kind, 'invalid');
  assert.equal(result.errors.consumerName, 'required');
  assert.equal(result.errors.consumerDocument, 'required');
  assert.equal(result.errors.consumerPhone, 'required');
  assert.equal(result.errors.consumerEmail, 'required');
  assert.equal(result.errors.relatedItem, 'required');
  assert.equal(result.errors.detail, 'required');
  assert.equal(result.errors.consumerRequest, 'required');
  assert.equal(result.errors.consent, 'required');
});

test('límites y formatos inválidos', () => {
  const result = validateComplaintPayload({
    ...VALID,
    consumerName: 'A',
    consumerDocument: 'abc',
    consumerPhone: 'llámame',
    consumerEmail: 'no-es-correo',
    relatedItem: 'x',
    amountCents: '-5',
    detail: 'corto',
    consumerRequest: 'corto',
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errors.consumerName, 'too_short');
  assert.equal(result.errors.consumerDocument, 'invalid_document');
  assert.equal(result.errors.consumerPhone, 'invalid_phone');
  assert.equal(result.errors.consumerEmail, 'invalid_email');
  assert.equal(result.errors.relatedItem, 'too_short');
  assert.equal(result.errors.amountCents, 'invalid_amount');
  assert.equal(result.errors.detail, 'too_short');
  assert.equal(result.errors.consumerRequest, 'too_short');
});

test('menor de edad: exige datos del padre/madre/tutor', () => {
  const missing = validateComplaintPayload({ ...VALID, isMinor: true });
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.equal(missing.errors.guardianName, 'guardian_required');
  assert.equal(missing.errors.guardianDocument, 'guardian_required');

  const complete = validateComplaintPayload({
    ...VALID,
    isMinor: true,
    guardianName: 'María Pérez',
    guardianDocument: '87654321',
  });
  assert.ok(complete.ok);
  assert.equal(complete.value.guardianName, 'María Pérez');
  assert.equal(complete.value.guardianDocument, '87654321');
});

test('honeypot: se descarta en silencio y no valida el resto', () => {
  const result = validateComplaintPayload({ ...VALID, company: 'Acme Spam' });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.spam, true);
    assert.deepEqual(result.errors, {});
  }
});

test('XSS: el texto se conserva como dato, nunca se interpreta acá', () => {
  const payload = '<script>alert(1)</script>';
  const result = validateComplaintPayload({ ...VALID, detail: `Detalle ${payload} suficiente` });
  assert.ok(result.ok);
  // React escapa al renderizar; el dominio no debe borrar contenido legítimo.
  assert.ok(result.value.detail.includes(payload));
});

test('el código público es opaco y el correlativo no sirve para consultar', () => {
  assert.equal(isValidPublicCode('RC-000001'), false);
  assert.equal(isValidPublicCode('123'), false);
  assert.equal(isValidPublicCode('A'.repeat(24)), true);
  assert.equal(isValidPublicCode('aB_-'.repeat(6)), true);
  assert.equal(formatComplaintNumber(1), 'RC-000001');
  assert.equal(formatComplaintNumber('42'), 'RC-000042');
  assert.equal(formatComplaintNumber(1234567), 'RC-1234567');
});

test('plazo: 15 días hábiles desde el día siguiente, en hora de Lima', () => {
  // Viernes 2026-10-23 10:00 en Lima (15:00 UTC).
  const submitted = new Date('2026-10-23T15:00:00.000Z');
  const due = complaintDueAt(submitted);

  // Empieza el lunes 26; 15 hábiles terminan el viernes 13 de noviembre.
  assert.equal(due.toISOString(), '2026-11-14T04:59:59.000Z');

  // Presentado 21:00 del jueves 22 en Lima (02:00 UTC del 23): cuenta desde el viernes 23.
  const lateThursday = complaintDueAt(new Date('2026-10-23T02:00:00.000Z'));
  assert.equal(lateThursday.toISOString(), '2026-11-13T04:59:59.000Z');

  assert.equal(COMPLAINT_RESPONSE_BUSINESS_DAYS, 15);
});

test('plazo: no cuenta sábado ni domingo', () => {
  const monday = new Date('2026-10-26T15:00:00.000Z');
  const threeDays = addBusinessDaysLima(monday, 3);
  // Mar 27, mié 28, jue 29.
  assert.equal(threeDays.toISOString(), '2026-10-30T04:59:59.000Z');
});

test('vencido: solo si sigue pendiente', () => {
  const due = new Date('2026-10-30T04:59:59.000Z');
  const after = new Date('2026-10-30T05:00:00.000Z');

  assert.equal(isComplaintOverdue('received', due, after), true);
  assert.equal(isComplaintOverdue('in_review', due, after), true);
  assert.equal(isComplaintOverdue('answered', due, after), false);
  assert.equal(isComplaintOverdue('received', due, new Date('2026-10-29T00:00:00.000Z')), false);
});

test('respuesta del proveedor: obligatoria, con límite y acciones opcionales', () => {
  const empty = validateComplaintResponse({ responseText: '' });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.errors.responseText, 'required');

  const short = validateComplaintResponse({ responseText: 'ok' });
  assert.equal(short.ok, false);

  const valid = validateComplaintResponse({
    responseText: 'Aprobamos el cambio del producto y coordinamos la entrega.',
    providerActions: 'Se verificó el lote con el proveedor.',
  });
  assert.equal(valid.ok, true);
  if (!valid.ok) return;
  assert.equal(valid.value.providerActions, 'Se verificó el lote con el proveedor.');

  const noActions = validateComplaintResponse({
    responseText: 'Aprobamos el cambio del producto y coordinamos la entrega.',
  });
  assert.equal(noActions.ok, true);
  if (!noActions.ok) return;
  assert.equal(noActions.value.providerActions, null);
});
