/**
 * lib/geo/ubigeo.server.ts — catálogo UBIGEO desde la base.
 *
 * Una sola fuente de verdad administrativa: `ubigeo_districts` (cargado desde
 * `db/migrations/026_seed_ubigeo.sql`). Nada de listas en el frontend ni de
 * APIs externas en runtime.
 */

import { getPlatformSql, requirePlatformSql, toNullableNumber } from '../platform-db.server';
import type { GeoPoint, UbigeoChain, UbigeoDistrictOption, UbigeoOption } from './types';

interface Row {
  [key: string]: unknown;
}

const asCode = (value: unknown) => String(value ?? '');

export async function listDepartments(): Promise<UbigeoOption[]> {
  const sql = getPlatformSql();
  if (!sql) return [];
  const rows = (await sql`
    SELECT code, name FROM ubigeo_departments ORDER BY name
  `) as Row[];
  return rows.map((row) => ({ code: asCode(row.code), name: String(row.name) }));
}

export async function listProvinces(departmentCode: string): Promise<UbigeoOption[]> {
  const sql = getPlatformSql();
  if (!sql) return [];
  const rows = (await sql`
    SELECT code, name FROM ubigeo_provinces
     WHERE department_code = ${departmentCode}
     ORDER BY name
  `) as Row[];
  return rows.map((row) => ({ code: asCode(row.code), name: String(row.name) }));
}

export async function listDistricts(provinceCode: string): Promise<UbigeoDistrictOption[]> {
  const sql = getPlatformSql();
  if (!sql) return [];
  const rows = (await sql`
    SELECT code, name, latitude, longitude FROM ubigeo_districts
     WHERE province_code = ${provinceCode}
     ORDER BY name
  `) as Row[];
  return rows.map((row) => ({
    code: asCode(row.code),
    name: String(row.name),
    latitude: toNullableNumber(row.latitude),
    longitude: toNullableNumber(row.longitude),
  }));
}

/** Resuelve la cadena completa de un código. `null` si no existe. */
export async function getUbigeoChain(code: string): Promise<UbigeoChain | null> {
  const sql = getPlatformSql();
  if (!sql) return null;
  const rows = (await sql`
    SELECT di.code, di.name AS district, di.latitude, di.longitude,
           p.name AS province, d.name AS department
      FROM ubigeo_districts di
      JOIN ubigeo_provinces p ON p.code = di.province_code
      JOIN ubigeo_departments d ON d.code = p.department_code
     WHERE di.code = ${code}
     LIMIT 1
  `) as Row[];
  const row = rows[0];
  if (!row) return null;

  const latitude = toNullableNumber(row.latitude);
  const longitude = toNullableNumber(row.longitude);
  return {
    code: asCode(row.code),
    department: String(row.department),
    province: String(row.province),
    district: String(row.district),
    centroid:
      latitude !== null && longitude !== null ? ({ latitude, longitude } satisfies GeoPoint) : null,
  };
}

/**
 * Coincidencia por nombres (reverse geocoding → ubigeo).
 *
 * Solo devuelve algo cuando departamento + provincia + distrito coinciden
 * exactamente (sin tildes ni mayúsculas). Cualquier duda → `null`: el pin sigue
 * siendo válido, pero la UI no cambia los selects por su cuenta.
 */
export async function matchUbigeoByName(input: {
  department: string | null;
  province: string | null;
  district: string | null;
}): Promise<UbigeoChain | null> {
  const district = (input.district ?? '').trim();
  if (!district) return null;

  const sql = requirePlatformSql();
  const rows = (await sql`
    SELECT di.code, di.name AS district, di.latitude, di.longitude,
           p.name AS province, d.name AS department
      FROM ubigeo_districts di
      JOIN ubigeo_provinces p ON p.code = di.province_code
      JOIN ubigeo_departments d ON d.code = p.department_code
     WHERE lower(translate(di.name, 'áéíóúüñÁÉÍÓÚÜÑ', 'aeiouunAEIOUUN')) =
           lower(translate(${district}, 'áéíóúüñÁÉÍÓÚÜÑ', 'aeiouunAEIOUUN'))
     LIMIT 20
  `) as Row[];

  const fold = (value: unknown) =>
    String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('es-PE')
      .replace(/\s+/g, ' ')
      .trim();

  const candidates = rows.filter((row) => {
    if (input.province && fold(row.province) !== fold(input.province)) return false;
    if (input.department && fold(row.department) !== fold(input.department)) return false;
    return true;
  });

  // Ambigüedad (mismo distrito en dos provincias y sin provincia en la
  // respuesta del proveedor): no se adivina.
  if (candidates.length !== 1) return null;

  const row = candidates[0];
  const latitude = toNullableNumber(row.latitude);
  const longitude = toNullableNumber(row.longitude);
  return {
    code: asCode(row.code),
    department: String(row.department),
    province: String(row.province),
    district: String(row.district),
    centroid:
      latitude !== null && longitude !== null ? ({ latitude, longitude } satisfies GeoPoint) : null,
  };
}

/**
 * Resuelve el UBIGEO probando varios nombres de distrito, del más específico al
 * más general.
 *
 * El proveedor no habla el idioma del catálogo: en Máncora devuelve
 * `district = "Barrio Nicaragua"` y `city = "Máncora"`; en Lima devuelve
 * `district = "Miraflores"` y `city = "Lima"`. En vez de adivinar cuál campo es
 * el distrito, se prueban en orden y se acepta el PRIMER nombre que resuelva a
 * una única cadena departamento → provincia → distrito.
 *
 * Si ningún candidato es inequívoco se devuelve `null`: el pin sigue siendo
 * válido, pero no se inventa un ubigeo ni se cambian los selects.
 */
export async function resolveUbigeoFromCandidates(input: {
  department: string | null;
  province: string | null;
  names: Array<string | null | undefined>;
}): Promise<UbigeoChain | null> {
  const seen = new Set<string>();

  for (const raw of input.names) {
    const name = (raw ?? '').trim();
    if (name.length < 2) continue;
    const key = name.toLocaleLowerCase('es-PE');
    if (seen.has(key)) continue;
    seen.add(key);

    const match = await matchUbigeoByName({
      department: input.department,
      province: input.province,
      district: name,
    });
    if (match) return match;
  }

  return null;
}

/** Nombre legible "Distrito, Provincia, Departamento". */
export function formatUbigeoChain(chain: UbigeoChain): string {
  return `${chain.district}, ${chain.province}, ${chain.department}`;
}
