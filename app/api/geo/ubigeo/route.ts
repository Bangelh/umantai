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

/**
 * Sin caché compartida.
 *
 * Netlify cachea esta ruta por path e ignora el query string: una respuesta de
 * departamentos se sirvió también para `?department=13`, así que el select de
 * provincias llegaba vacío. Son tres consultas indexadas que la UI pide solo al
 * cambiar de nivel: no compensa cachearlas mal.
 */
const HEADERS = { 'cache-control': 'no-store' } as const;

export async function GET(request: Request) {
  if (!isPlatformDbConfigured()) {
    return NextResponse.json(
      { ok: false, code: 'db_not_configured', error: 'Catálogo no disponible.' },
      { status: 503, headers: HEADERS },
    );
  }

  const url = new URL(request.url);
  const department = (url.searchParams.get('department') ?? '').trim();
  const province = (url.searchParams.get('province') ?? '').trim();

  if (province && !/^[0-9]{4}$/.test(province)) {
    return NextResponse.json(
      { ok: false, code: 'invalid_province' },
      { status: 400, headers: HEADERS },
    );
  }
  if (department && !/^[0-9]{2}$/.test(department)) {
    return NextResponse.json(
      { ok: false, code: 'invalid_department' },
      { status: 400, headers: HEADERS },
    );
  }

  try {
    if (province) {
      return NextResponse.json(
        { ok: true, level: 'districts', districts: await listDistricts(province) },
        { headers: HEADERS },
      );
    }
    if (department) {
      return NextResponse.json(
        { ok: true, level: 'provinces', provinces: await listProvinces(department) },
        { headers: HEADERS },
      );
    }
    return NextResponse.json(
      { ok: true, level: 'departments', departments: await listDepartments() },
      { headers: HEADERS },
    );
  } catch {
    return NextResponse.json(
      { ok: false, code: 'db_error', error: 'No pudimos cargar el catálogo.' },
      { status: 503, headers: HEADERS },
    );
  }
}
