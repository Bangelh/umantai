#!/usr/bin/env node
/**
 * scripts/build-ubigeo.mjs — genera el snapshot versionado de UBIGEO.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  QUÉ HACE
 *
 *  1. Lee (o descarga) las tres tablas de UBIGEO del dataset público con
 *     equivalencias INEI ↔ RENIEC (MIT), cuyo origen último es el listado de
 *     códigos estandarizados del INEI.
 *  2. Normaliza los nombres a formato de presentación (mayúsculas → Título) y
 *     restaura tildes usando la columna `capital`, que sí viene acentuada.
 *  3. Escribe `db/migrations/026_seed_ubigeo.sql` (idempotente) y
 *     `data/ubigeo/manifest.json` con fuente, fecha, checksum y versión.
 *
 *  USO
 *    node scripts/build-ubigeo.mjs                 # descarga las fuentes
 *    node scripts/build-ubigeo.mjs --from <dir>    # usa CSVs ya descargados
 *
 *  NO se ejecuta en build ni en runtime: el catálogo vive en la base y el
 *  snapshot SQL es el artefacto versionado. Sin llamadas a APIs externas en
 *  producción.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SNAPSHOT_VERSION = '2026.10';
const BASE = 'https://raw.githubusercontent.com/jmcastagnetto/ubigeo-peru-aumentado/main';
const SOURCES = {
  ubigeo_departamento: `${BASE}/ubigeo_departamento.csv`,
  ubigeo_provincia: `${BASE}/ubigeo_provincia.csv`,
  ubigeo_distrito: `${BASE}/ubigeo_distrito.csv`,
};

const fromFlag = process.argv.indexOf('--from');
const localDir = fromFlag > -1 ? process.argv[fromFlag + 1] : null;

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }

  const [header, ...body] = rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
  const keys = header.map((key) => key.trim());
  return body.map((cells) =>
    Object.fromEntries(keys.map((key, index) => [key, (cells[index] ?? '').trim()])),
  );
}

async function load(name) {
  // La procedencia que se documenta es SIEMPRE la URL canónica, aunque se lea
  // una copia local (el snapshot debe poder reproducirse).
  const url = SOURCES[name];
  if (localDir) {
    const file = path.join(localDir, `${name}.csv`);
    return { text: await readFile(file, 'utf8'), url, localPath: path.relative(process.cwd(), file) };
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`No se pudo descargar ${url}: HTTP ${response.status}`);
  return { text: await response.text(), url };
}

/** "SAN JUAN DE LURIGANCHO" → "San Juan de Lurigancho" */
function titleCase(value) {
  const minor = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y', 'en']);
  return value
    .toLocaleLowerCase('es-PE')
    .split(/(\s+)/)
    .map((word, index) => {
      if (!word.trim()) return word;
      if (index > 0 && minor.has(word)) return word;
      return word.charAt(0).toLocaleUpperCase('es-PE') + word.slice(1);
    })
    .join('');
}

/** Sin tildes ni mayúsculas, para comparar nombres entre columnas. */
function fold(value) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es-PE')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * El listado del INEI trae los nombres en mayúsculas y sin tildes. `capital`
 * sí viene acentuada y, cuando coincide con el nombre del distrito, aporta la
 * grafía correcta (Máncora, Asunción, Andahuaylas…).
 */
function displayName(raw, capital) {
  const normalized = fold(raw);
  if (capital && fold(capital) === normalized) return titleCase(capital);
  return titleCase(raw);
}

const sqlText = (value) => `'${String(value).replace(/'/g, "''")}'`;
const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const [departmentsCsv, provincesCsv, districtsCsv] = await Promise.all([
  load('ubigeo_departamento'),
  load('ubigeo_provincia'),
  load('ubigeo_distrito'),
]);

const CODE = /^[0-9]{6}$/;
let skipped = 0;

/**
 * El dataset tiene filas con `inei = NA` (sin código INEI: la equivalencia con
 * RENIEC no se pudo resolver). Se descartan en lugar de inventar un código: la
 * jerarquía del RENIEC de esas filas no coincide con la del INEI.
 */
const rowsWithCode = (rows) => {
  const out = [];
  for (const row of rows) {
    const code = row.inei;
    if (!CODE.test(code) && !CODE.test(`${code}00`)) {
      skipped += 1;
      continue;
    }
    out.push(row);
  }
  return out;
};

const departments = rowsWithCode(parseCsv(departmentsCsv.text))
  .map((row) => ({
    code: row.inei.slice(0, 2),
    name: displayName(row.departamento, row.capital),
  }))
  .sort((a, b) => a.code.localeCompare(b.code));

const provinces = rowsWithCode(parseCsv(provincesCsv.text))
  .map((row) => ({
    code: row.inei.slice(0, 4),
    departmentCode: row.inei.slice(0, 2),
    name: displayName(row.provincia, row.capital),
  }))
  .sort((a, b) => a.code.localeCompare(b.code));

const districts = rowsWithCode(parseCsv(districtsCsv.text))
  .map((row) => ({
    code: row.inei.slice(0, 6),
    provinceCode: row.inei.slice(0, 4),
    name: displayName(row.distrito, row.capital),
    latitude: num(row.latitude),
    longitude: num(row.longitude),
  }))
  .sort((a, b) => a.code.localeCompare(b.code));

if (departments.length < 24 || provinces.length < 190 || districts.length < 1800) {
  throw new Error(
    `Snapshot incompleto: ${departments.length} departamentos, ${provinces.length} provincias, ` +
      `${districts.length} distritos. Se aborta para no sembrar datos parciales.`,
  );
}

const departmentCodes = new Set(departments.map((row) => row.code));
const unique = (rows, label) => {
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.code)) throw new Error(`Código duplicado en ${label}: ${row.code}`);
    seen.add(row.code);
  }
};
unique(departments, 'departamentos');
unique(provinces, 'provincias');
unique(districts, 'distritos');
const provinceCodes = new Set(provinces.map((row) => row.code));
for (const province of provinces) {
  if (!departmentCodes.has(province.departmentCode)) {
    throw new Error(`Provincia ${province.code} apunta a un departamento inexistente.`);
  }
}
for (const district of districts) {
  if (!provinceCodes.has(district.provinceCode)) {
    throw new Error(`Distrito ${district.code} apunta a una provincia inexistente.`);
  }
}

const checksum = (text) => createHash('sha256').update(text).digest('hex');

const lines = [];
lines.push('-- =============================================================================');
lines.push('--  Umantai · Snapshot UBIGEO — 026 (GENERADO, no editar a mano)');
lines.push(`--  Versión: ${SNAPSHOT_VERSION}`);
lines.push('--  Generado por: scripts/build-ubigeo.mjs');
lines.push(`--  Fuente: ${departmentsCsv.url}`);
lines.push('--          (dataset público con equivalencias INEI ↔ RENIEC, licencia MIT;');
lines.push('--           el listado de códigos es el oficial de INEI)');
lines.push('--          Regenerar con: node scripts/build-ubigeo.mjs');
lines.push(`--  Filas: ${departments.length} departamentos · ${provinces.length} provincias · ${districts.length} distritos`);
lines.push(`--  Filas descartadas por falta de código INEI: ${skipped}`);
lines.push('--  IDEMPOTENTE: ON CONFLICT actualiza el nombre si el INEI lo cambia.');
lines.push('-- =============================================================================');
lines.push('');
lines.push('BEGIN;');
lines.push('');

lines.push('INSERT INTO ubigeo_departments (code, name) VALUES');
lines.push(
  departments.map((row) => `  (${sqlText(row.code)}, ${sqlText(row.name)})`).join(',\n') + '\n' +
    'ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;',
);
lines.push('');

lines.push('INSERT INTO ubigeo_provinces (code, department_code, name) VALUES');
lines.push(
  provinces
    .map((row) => `  (${sqlText(row.code)}, ${sqlText(row.departmentCode)}, ${sqlText(row.name)})`)
    .join(',\n') + '\n' + 'ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, department_code = EXCLUDED.department_code;',
);
lines.push('');

lines.push('INSERT INTO ubigeo_districts (code, province_code, name, latitude, longitude) VALUES');
lines.push(
  districts
    .map(
      (row) =>
        `  (${sqlText(row.code)}, ${sqlText(row.provinceCode)}, ${sqlText(row.name)}, ` +
        `${row.latitude ?? 'NULL'}, ${row.longitude ?? 'NULL'})`,
    )
    .join(',\n') +
    '\n' +
    'ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, province_code = EXCLUDED.province_code, ' +
    'latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude;',
);
lines.push('');
lines.push('COMMIT;');

await mkdir(path.join(process.cwd(), 'db', 'migrations'), { recursive: true });
await writeFile(path.join(process.cwd(), 'db', 'migrations', '026_seed_ubigeo.sql'), lines.join('\n') + '\n', 'utf8');

const manifest = {
  version: SNAPSHOT_VERSION,
  generatedAt: new Date().toISOString(),
  generator: 'scripts/build-ubigeo.mjs',
  source: {
    description:
      'Dataset público de UBIGEO con equivalencias INEI ↔ RENIEC (MIT). Origen de los códigos: INEI, códigos estandarizados.',
    license: 'MIT',
    files: [
      { name: 'ubigeo_departamento.csv', url: departmentsCsv.url, sha256: checksum(departmentsCsv.text) },
      { name: 'ubigeo_provincia.csv', url: provincesCsv.url, sha256: checksum(provincesCsv.text) },
      { name: 'ubigeo_distrito.csv', url: districtsCsv.url, sha256: checksum(districtsCsv.text) },
    ],
    downloadCommand: 'node scripts/build-ubigeo.mjs',
  },
  counts: {
    departments: departments.length,
    provinces: provinces.length,
    districts: districts.length,
    skippedWithoutIneiCode: skipped,
  },
  artifacts: {
    seed: 'db/migrations/026_seed_ubigeo.sql',
    seedSha256: checksum(lines.join('\n') + '\n'),
  },
};

await mkdir(path.join(process.cwd(), 'data', 'ubigeo'), { recursive: true });
await writeFile(
  path.join(process.cwd(), 'data', 'ubigeo', 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
);

console.log(
  `[ubigeo] ${departments.length} departamentos · ${provinces.length} provincias · ${districts.length} distritos`,
);
console.log(`[ubigeo] seed: ${manifest.artifacts.seed} (${manifest.artifacts.seedSha256.slice(0, 12)}…)`);
