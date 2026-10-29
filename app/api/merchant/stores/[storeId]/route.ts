/**
 * PATCH /api/merchant/stores/<storeId> — completa la ubicación de la tienda.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  POR QUÉ EXISTE
 *
 *  `stores_active_location_chk` exige latitud y longitud para poner
 *  `active = TRUE`. El alta de tienda pedía la zona en un `<select>` OPCIONAL, y
 *  quien no la elegía quedaba en un callejón sin salida: el comerciante no tenía
 *  dónde completarla y el administrador no podía activarla
 *  (`store_location_required`). Una tienda creada así nunca se publicaba.
 *
 *  Este endpoint es la pieza que faltaba: el comerciante elige una zona del
 *  piloto (mismos presets que el alta) y la tienda queda lista para la revisión.
 *
 *  NO activa la tienda. La publicación sigue siendo exclusiva de Platform Admin
 *  (`PATCH /api/admin/stores`): son dos permisos distintos y se mantienen así.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { NextResponse } from 'next/server';

import { getSessionUser } from '@/lib/auth.server';
import { findLocationPreset } from '@/lib/locations';
import { logEvent } from '@/lib/observability.server';
import { platformErrorResponse, readJsonBody } from '@/lib/platform-api.server';
import { requirePlatformSql } from '@/lib/platform-db.server';
import { rateLimitGate } from '@/lib/rate-limit-http.server';
import { requireStoreAccess } from '@/lib/stores.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PatchBody {
  zoneId?: unknown;
}

interface RouteContext {
  params: Promise<{ storeId: string }>;
}

export async function PATCH(request: Request, context: RouteContext) {
  const user = await getSessionUser(request.headers);
  if (!user) {
    return NextResponse.json(
      { error: 'Necesitas iniciar sesión.', code: 'not_authenticated' },
      { status: 401 },
    );
  }

  const { storeId } = await context.params;

  const gate = await rateLimitGate(request, 'merchant-store-location', {
    limit: 10,
    windowMs: 60_000,
    key: `merchant-store-location:${user.id}`,
  });
  if (gate) return gate;

  const body = await readJsonBody<PatchBody>(request);
  const zone = findLocationPreset(typeof body?.zoneId === 'string' ? body.zoneId : null);
  if (!zone) {
    return NextResponse.json(
      { error: 'Elige una zona válida.', code: 'invalid_input' },
      { status: 400 },
    );
  }

  try {
    // `admin` como rol mínimo: owner y admin de la tienda pueden corregirla.
    // Un usuario ajeno recibe 403/404 sin filtrar si la tienda existe.
    await requireStoreAccess(user.id, storeId, 'admin');

    const sql = requirePlatformSql();
    const rows = await sql`
      UPDATE stores
         SET latitude = ${zone.latitude},
             longitude = ${zone.longitude},
             district = COALESCE(NULLIF(btrim(district), ''), ${zone.label}),
             updated_at = NOW()
       WHERE id = ${storeId}::uuid
       RETURNING id, slug, active, latitude, longitude, district
    `;

    const row = (rows[0] ?? null) as Record<string, unknown> | null;
    if (!row) {
      return NextResponse.json({ error: 'Tienda no encontrada.', code: 'store_not_found' }, { status: 404 });
    }

    logEvent('store_location_updated', {
      storeId,
      userId: user.id,
      zone: zone.id,
    });

    return NextResponse.json({
      store: {
        id: String(row.id),
        slug: String(row.slug),
        active: row.active === true,
        district: (row.district as string | null) ?? null,
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
      },
    });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
