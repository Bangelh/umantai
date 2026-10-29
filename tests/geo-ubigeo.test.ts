/**
 * tests/geo-ubigeo.test.ts — integridad del snapshot UBIGEO.
 *
 * El catálogo NO se pide a ninguna API en runtime: se versiona como SQL
 * generado. Estos tests verifican el artefacto (manifest + seed) sin base de
 * datos, para que un snapshot incompleto falle en CI y no en producción.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const manifest = JSON.parse(
  readFileSync(join(process.cwd(), 'data', 'ubigeo', 'manifest.json'), 'utf8'),
) as {
  version: string;
  generatedAt: string;
  source: { license: string; files: { name: string; url: string; sha256: string }[] };
  counts: { departments: number; provinces: number; districts: number };
  artifacts: { seed: string; seedSha256: string };
};

const seed = readFileSync(join(process.cwd(), 'db', 'migrations', '026_seed_ubigeo.sql'), 'utf8');

test('el manifest documenta fuente, versión y checksum', () => {
  assert.match(manifest.version, /^\d{4}\.\d{2}$/);
  assert.ok(manifest.generatedAt);
  assert.equal(manifest.source.license, 'MIT');
  assert.equal(manifest.source.files.length, 3);
  for (const file of manifest.source.files) {
    assert.match(file.url, /^https:\/\//);
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
  }
  assert.match(manifest.artifacts.seedSha256, /^[0-9a-f]{64}$/);
});

test('el snapshot cubre el Perú completo', () => {
  assert.equal(manifest.counts.departments, 25);
  assert.ok(manifest.counts.provinces >= 190, `provincias: ${manifest.counts.provinces}`);
  assert.ok(manifest.counts.districts >= 1800, `distritos: ${manifest.counts.districts}`);
});

test('el seed es idempotente y no duplica códigos', () => {
  assert.match(seed, /ON CONFLICT \(code\) DO UPDATE/);
  assert.match(seed, /BEGIN;/);
  assert.match(seed, /COMMIT;/);

  const codes = [...seed.matchAll(/^\s*\('([0-9]{6})', '[0-9]{4}',/gm)].map((match) => match[1]);
  assert.ok(codes.length >= 1800, `distritos en el seed: ${codes.length}`);
  assert.equal(new Set(codes).size, codes.length);
});

test('Máncora existe con su centroide (tienda fuera de Lima)', () => {
  const line = seed.split('\n').find((row) => row.includes("('200706'"));
  assert.ok(line, 'falta el distrito 200706');
  assert.match(line, /Máncora/);
  assert.match(line, /-4\.10/);
  assert.match(line, /-81\.05/);
});

test('las provincias cuelgan de un departamento existente', () => {
  const departmentCodes = new Set(
    [...seed.matchAll(/^\s*\('([0-9]{2})', '/gm)].map((match) => match[1]),
  );
  const provinceRows = [...seed.matchAll(/^\s*\('([0-9]{4})', '([0-9]{2})',/gm)];
  assert.ok(provinceRows.length >= 190);
  for (const [, code, departmentCode] of provinceRows) {
    assert.ok(departmentCodes.has(departmentCode), `${code} apunta a ${departmentCode}`);
  }
});
