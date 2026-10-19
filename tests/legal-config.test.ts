/**
 * tests/legal-config.test.ts — documentos legales y datos del negocio.
 *
 * Lo importante que se verifica acá NO es la redacción: es que no haya datos
 * legales inventados. Razón social, RUC, dirección, correo legal, jurisdicción
 * y plazo de reembolso deben seguir siendo placeholders explícitos hasta que el
 * negocio los confirme.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PENDING_BUSINESS_FIELDS,
  businessConfig,
  businessValue,
  isPendingBusinessField,
  pendingBusinessFields,
  pendingLabel,
} from '../config/business';
import { LEGAL_DOCUMENTS, LEGAL_DRAFT_NOTICE, LEGAL_SLUGS, getLegalDocument } from '../lib/legal';
import { LEGAL_NAV_LINKS, ADMIN_NAV_LINKS, HELP_NAV_LINKS, SHOP_NAV_LINKS } from '../lib/navigation';

test('existen los 5 documentos legales y las rutas son las anunciadas', () => {
  assert.deepEqual([...LEGAL_SLUGS].sort(), [
    'aviso-legal',
    'cookies',
    'privacidad',
    'reembolsos',
    'terminos',
  ]);
  assert.equal(LEGAL_SLUGS.length, 5);

  const hrefs = LEGAL_NAV_LINKS.map((link) => link.href);
  for (const slug of LEGAL_SLUGS) {
    assert.ok(hrefs.includes(`/legal/${slug}`), `falta enlace a /legal/${slug}`);
  }
  assert.ok(HELP_NAV_LINKS.some((link) => link.href === '/contacto'));
});

test('cada documento tiene título, descripción y secciones', () => {
  for (const slug of LEGAL_SLUGS) {
    const document = getLegalDocument(slug);
    assert.ok(document, `falta el documento ${slug}`);
    assert.ok(document.title.length > 3);
    assert.ok(document.description.length > 20);
    assert.ok(document.sections.length >= 3, `${slug} tiene pocas secciones`);
    for (const section of document.sections) {
      assert.ok(section.heading.length > 0);
      assert.ok(section.paragraphs.length > 0);
    }
  }
  assert.equal(getLegalDocument('no-existe'), null);
});

test('los datos legales NO están inventados: siguen pendientes y marcados', () => {
  // Si el negocio confirma un dato, este test debe actualizarse a propósito.
  assert.equal(businessConfig.legalName, null);
  assert.equal(businessConfig.ruc, null);
  assert.equal(businessConfig.address, null);
  assert.equal(businessConfig.jurisdiction, null);
  assert.equal(businessConfig.refundWindowDays, null);
  assert.equal(businessConfig.legalEmail, null);

  const pending = pendingBusinessFields();
  for (const field of Object.keys(PENDING_BUSINESS_FIELDS) as Array<keyof typeof PENDING_BUSINESS_FIELDS>) {
    assert.ok(pending.includes(field), `${field} debería figurar como pendiente`);
    assert.ok(isPendingBusinessField(field));
    assert.equal(businessValue(field), pendingLabel(field));
    assert.match(businessValue(field), /\[PENDIENTE: definir /);
  }
});

test('los textos legales muestran el placeholder en vez de un dato ficticio', () => {
  const all = JSON.stringify(LEGAL_DOCUMENTS);
  assert.ok(all.includes('[PENDIENTE: definir razón social]'));
  assert.ok(all.includes('[PENDIENTE: definir RUC]'));
  assert.ok(all.includes('[PENDIENTE: definir plazo de reembolso]'));
  assert.ok(all.includes('[PENDIENTE: definir jurisdicción]'));

  // No debe aparecer un RUC con forma de RUC real (11 dígitos).
  assert.ok(!/\b\d{11}\b/.test(all), 'aparece un posible RUC inventado');
});

test('se declara como borrador y no como asesoría legal', () => {
  assert.match(LEGAL_DRAFT_NOTICE, /Borrador operativo/);
  assert.match(LEGAL_DRAFT_NOTICE, /No constituye asesoría jurídica/);
});

test('la política de cookies describe lo que la app realmente usa', () => {
  const cookies = LEGAL_DOCUMENTS.cookies;
  const text = JSON.stringify(cookies);
  assert.ok(text.includes('localStorage'));
  assert.ok(text.includes('carrito'));
  assert.ok(text.includes('No hay cookies de analítica'));
});

test('navegación: rutas internas, sin duplicados y con secciones de admin', () => {
  const groups = [SHOP_NAV_LINKS, LEGAL_NAV_LINKS, HELP_NAV_LINKS, ADMIN_NAV_LINKS];

  for (const group of groups) {
    const hrefs = group.map((link) => link.href);
    assert.equal(new Set(hrefs).size, hrefs.length, 'hay enlaces duplicados');
    for (const href of hrefs) {
      assert.ok(href.startsWith('/'), `${href} no es una ruta interna`);
    }
  }

  assert.ok(ADMIN_NAV_LINKS.some((link) => link.href === '/admin/analytics'));
  assert.ok(ADMIN_NAV_LINKS.some((link) => link.href === '/admin/inventario'));
});
