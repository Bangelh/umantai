/**
 * GET /api/geo/ubigeo — catálogo para los selects dependientes.
 *
 *   ?             → departamentos
 *   ?department=15 → provincias de Lima
 *   ?province=1501 → distritos de Lima (con centroide)
 *
 * Público y cacheable: son datos administrativos oficiales, no información de
 * ninguna tienda. No hay llamadas a APIs externas: se lee del catálogo en base.
 */

import { NextResponse } from 'next/server';

import { listDepartments, listDistricts, listProvinces } from '@/lib/geo/ubigeo.server';
import { isPlatformDbConfigured } from '@/lib/platform-db.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CACHE = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400';
const NO_STORE = 'no-store';

export async function GET(request: Request) {
  if (!isPlatformDbConfigured()) {
    return NextResponse.json(
      { ok: false, code: 'db_not_configured', error: 'Catálogo no disponible.' },
      { status: 503, headers: { 'cache-control': NO_STORE } },
    );
  }

  const url = new URL(request.url);
  const department = (url.searchParams.get('department') ?? '').trim();
  const province = (url.searchParams.get('province') ?? '').trim();

  if (province && !/^[0-9]{4}$/.test(province)) {
    return NextResponse.json(
      { ok: false, code: 'invalid_province' },
      { status: 400, headers: { 'cache-control': NO_STORE } },
    );
  }
  if (department && !/^[0-9]{2}$/.test(department)) {
    return NextResponse.json(
      { ok: false, code: 'invalid_department' },
      { status: 400, headers: { 'cache-control': NO_STORE } },
    );
  }

  try {
    if (province) {
      return NextResponse.json(
        { ok: true, level: 'districts', districts: await listDistricts(province) },
        { headers: { 'cache-control': CACHE } },
      );
    }
    if (department) {
      return NextResponse.json(
        { ok: true, level: 'provinces', provinces: await listProvinces(department) },
        { headers: { 'cache-control': CACHE } },
      );
    }
    return NextResponse.json(
      { ok: true, level: 'departments', departments: await listDepartments() },
      { headers: { 'cache-control': CACHE } },
    );
  } catch {
    return NextResponse.json(
      { ok: false, code: 'db_error', error: 'No pudimos cargar el catálogo.' },
      { status: 503, headers: { 'cache-control': NO_STORE } },
    );
  }
}
