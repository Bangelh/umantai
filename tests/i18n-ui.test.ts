/**
 * tests/i18n-ui.test.ts — el escáner de interfaz corre en CI.
 *
 * Ejecuta `scripts/check-i18n-strings.mjs` en modo JSON y falla si:
 *   · alguna clave usada con `t('…')` no existe en es/en;
 *   · apareció un string de interfaz hardcodeado fuera de la allowlist.
 *
 * Así el contrato no depende de que alguien recuerde correr el script a mano.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

test('todas las claves usadas existen y no hay strings nuevos sin traducir', () => {
  const result = spawnSync(
    process.execPath,
    [join(process.cwd(), 'scripts/check-i18n-strings.mjs'), '--json'],
    { encoding: 'utf8', cwd: process.cwd() },
  );

  assert.equal(result.status, 0, `el escáner falló:\n${result.stderr}`);
  const report = JSON.parse(result.stdout) as {
    missingKeys: Array<{ key: string; file: string; line: number }>;
    hardcoded: Array<{ file: string; findings: Array<{ line: number; value: string }> }>;
    hardcodedCount: number;
  };

  assert.deepEqual(
    report.missingKeys,
    [],
    `claves inexistentes: ${report.missingKeys.map((entry) => `${entry.file}:${entry.key}`).join(', ')}`,
  );
  assert.equal(
    report.hardcodedCount,
    0,
    `strings sin traducir: ${report.hardcoded
      .map((entry) => `${entry.file} (${entry.findings.length})`)
      .join(', ')}`,
  );
});
