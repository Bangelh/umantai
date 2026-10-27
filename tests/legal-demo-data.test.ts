/**
 * tests/legal-demo-data.test.ts — datos legales DEMO (solo staging).
 *
 * Para la revisión visual del cliente, staging puede mostrar datos del titular de
 * ejemplo en lugar de los `[PENDIENTE: …]`. Este test fija las tres garantías:
 *
 *   1. con la bandera y fuera de Producción los datos demo se muestran;
 *   2. en Producción (`APP_ENV`/`VERCEL_ENV`, incluso un `APP_ENV` desconocido) la
 *      bandera se IGNORA y vuelven los placeholders;
 *   3. `isLegalReadyForLaunch()` sigue en `false`: los datos demo no valen para el
 *      cutover, y las páginas que los muestran llevan el aviso visible.
 *
 * El entorno de este archivo imita al build de staging antes de importar el
 * contenido legal, porque `lib/legal.ts` arma los textos al importarse.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { LEGAL_DEMO_NOTICE, LEGAL_DEMO_VALUES } from '../config/legal-demo';

process.env.APP_ENV = 'staging';
process.env.LEGAL_DEMO_DATA = '1';
delete process.env.VERCEL_ENV;

const business = await import('../config/business');
const { LEGAL_DOCUMENTS } = await import('../lib/legal');

const ENV_KEYS = ['APP_ENV', 'LEGAL_DEMO_DATA', 'VERCEL_ENV'] as const;

/** Ejecuta el bloque con un entorno exacto y lo restaura siempre. */
function withEnv(
  values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>,
  run: () => void,
): void {
  const snapshot = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of snapshot) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('en staging la bandera muestra los datos de demostración del titular', () => {
  withEnv({ APP_ENV: 'staging', LEGAL_DEMO_DATA: '1' }, () => {
    assert.equal(business.isLegalDemoDataActive(), true);

    assert.equal(business.businessValue('legalName'), 'UMANTAI DEMO S.A.C.');
    assert.equal(business.businessValue('ruc'), '00000000000');
    assert.equal(business.businessValue('address'), 'Dirección de demostración — por confirmar');
    assert.equal(business.businessValue('jurisdiction'), 'Perú — por confirmar');

    for (const field of ['legalName', 'ruc', 'address', 'jurisdiction'] as const) {
      assert.equal(business.businessValue(field), LEGAL_DEMO_VALUES[field]);
    }

    // El texto legal ya armado los usa y deja de mostrar el placeholder: los
    // cuatro datos del titular (incluida la jurisdicción) se ven en las páginas.
    const documents = JSON.stringify(LEGAL_DOCUMENTS);
    assert.ok(documents.includes('UMANTAI DEMO S.A.C.'));
    assert.ok(documents.includes('00000000000'));
    assert.ok(documents.includes('Dirección de demostración — por confirmar'));
    assert.ok(documents.includes('Perú — por confirmar'));
    assert.ok(!documents.includes('[PENDIENTE: definir razón social]'));
    assert.ok(!documents.includes('[PENDIENTE: definir RUC]'));
    assert.ok(!documents.includes('[PENDIENTE: definir jurisdicción]'));
  });
});

test('los valores demo se reconocen como falsos a simple vista', () => {
  assert.equal(LEGAL_DEMO_VALUES.ruc, '00000000000');
  assert.match(LEGAL_DEMO_VALUES.legalName, /DEMO/);
  assert.match(LEGAL_DEMO_VALUES.address, /por confirmar/);
  assert.match(LEGAL_DEMO_VALUES.jurisdiction, /por confirmar/);
});

test('el aviso visible es exactamente el exigido y aparece en cada página con datos demo', () => {
  assert.equal(LEGAL_DEMO_NOTICE, 'DATOS DE DEMOSTRACIÓN — NO VÁLIDOS PARA PRODUCCIÓN');

  // Cada página con datos del titular debe mostrar el aviso y condicionarlo con
  // `isLegalDemoDataActive()` (la bandeja de reclamaciones lo recibe como prop).
  const pages: Array<[file: string, needles: string[]]> = [
    ['../app/legal/page.tsx', ['LegalDemoNotice', 'isLegalDemoDataActive() && <LegalDemoNotice']],
    ['../app/legal/[slug]/page.tsx', ['LegalDemoNotice', 'isLegalDemoDataActive() && <LegalDemoNotice']],
    ['../app/libro-de-reclamaciones/page.tsx', ['demoData={isLegalDemoDataActive()}']],
    ['../app/libro-de-reclamaciones/ComplaintPage.tsx', ['LegalDemoNotice', '{demoData &&']],
    [
      '../app/libro-de-reclamaciones/seguimiento/[code]/page.tsx',
      ['LegalDemoNotice', 'isLegalDemoDataActive() && <LegalDemoNotice'],
    ],
    ['../components/legal/LegalDemoNotice.tsx', ['LEGAL_DEMO_NOTICE']],
  ];

  for (const [file, needles] of pages) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const needle of needles) {
      assert.ok(source.includes(needle), `${file} no cumple: ${needle}`);
    }
  }
});

test('los datos demo NO hacen pasar isLegalReadyForLaunch()', () => {
  withEnv({ APP_ENV: 'staging', LEGAL_DEMO_DATA: '1' }, () => {
    assert.equal(business.isLegalReadyForLaunch(), false, 'demo nunca está listo para lanzar');
    assert.deepEqual([...business.pendingBusinessFields()].sort(), [
      'address',
      'jurisdiction',
      'legalName',
      'ruc',
    ]);
  });
});

test('sin la bandera vuelven los placeholders, aunque el entorno sea staging', () => {
  withEnv({ APP_ENV: 'staging', LEGAL_DEMO_DATA: undefined }, () => {
    assert.equal(business.isLegalDemoDataActive(), false);
    assert.equal(business.businessValue('legalName'), '[PENDIENTE: definir razón social]');
    assert.equal(business.businessValue('ruc'), '[PENDIENTE: definir RUC]');
    assert.equal(business.isLegalReadyForLaunch(), false);
  });
});

test('en Producción la bandera se ignora (APP_ENV=production)', () => {
  withEnv({ APP_ENV: 'production', LEGAL_DEMO_DATA: '1' }, () => {
    assert.equal(business.isLegalDemoDataActive(), false, 'los datos demo no llegan a Producción');
    assert.equal(business.businessValue('legalName'), '[PENDIENTE: definir razón social]');
    assert.equal(business.businessValue('ruc'), '[PENDIENTE: definir RUC]');
    assert.equal(business.isLegalReadyForLaunch(), false);
  });
});

test('en Producción la bandera se ignora (VERCEL_ENV=production, sin APP_ENV)', () => {
  withEnv({ APP_ENV: undefined, VERCEL_ENV: 'production', LEGAL_DEMO_DATA: '1' }, () => {
    assert.equal(business.isLegalDemoDataActive(), false);
    assert.equal(business.businessValue('legalName'), '[PENDIENTE: definir razón social]');
  });
});

test('un APP_ENV desconocido se trata como Producción (fail-closed)', () => {
  withEnv({ APP_ENV: 'preprod-eu', LEGAL_DEMO_DATA: '1' }, () => {
    assert.equal(business.isLegalDemoDataActive(), false);
    assert.equal(business.businessValue('legalName'), '[PENDIENTE: definir razón social]');
    assert.equal(business.isLegalReadyForLaunch(), false);
  });
});
