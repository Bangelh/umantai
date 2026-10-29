/**
 * /api/admin/stores — control de alta de comercios.
 *
 *   GET   → tiendas (pendientes primero) con dueño y conteos.
 *   PATCH → { storeId, active } activa/desactiva una tienda.
 *
 * Autenticación: token de administración (`x-admin-token`) MIENTRAS no exista
 * un rol de plataforma en `users`. Es el puente documentado en AUTH_DECISION.md;
 * no se mantiene un tercer sistema de auth: es el mismo `ADMIN_API_SECRET` que
 * ya protege /admin y se migrará a un rol global cuando se defina.
 */

import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/admin.server';
import { logEvent } from '@/lib/observability.server';
import { platformErrorResponse, readJsonBody } from '@/lib/platform-api.server';
import { requirePlatformSql, toIsoString, toNumber } from '@/lib/platform-db.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const access = await requireAdminAccess(request);
  if (!access.ok) {
    return NextResponse.json({ error: access.message, code: access.code }, { status: access.status });
  }

  try {
    const sql = requirePlatformSql();
    const rows = await sql`
      SELECT s.id, s.name, s.slug, s.category, s.active, s.is_default,
             s.address, s.district, s.city, s.latitude, s.longitude,
             (s.latitude IS NOT NULL AND s.longitude IS NOT NULL) AS has_location,
             s.created_at, s.approved_at,
             (SELECT COUNT(*)::int FROM store_members m WHERE m.store_id = s.id) AS member_count,
             (SELECT COUNT(*)::int FROM store_products p WHERE p.store_id = s.id) AS product_count,
             (SELECT u.email
                FROM store_members m2
                JOIN users u ON u.id = m2.user_id
               WHERE m2.store_id = s.id AND m2.role = 'owner'
               LIMIT 1) AS owner_email
        FROM stores s
       ORDER BY s.active ASC, s.created_at DESC
       LIMIT 200
    `;

    return NextResponse.json({
      stores: (rows as Array<Record<string, unknown>>).map((row) => ({
        id: String(row.id),
        name: String(row.name),
        slug: String(row.slug),
        category: (row.category as string | null) ?? null,
        active: row.active === true,
        isDefault: row.is_default === true,
        address: (row.address as string | null) ?? null,
        district: (row.district as string | null) ?? null,
        city: (row.city as string | null) ?? null,
        latitude: row.latitude === null ? null : toNumber(row.latitude),
        longitude: row.longitude === null ? null : toNumber(row.longitude),
        // Sin coordenadas el constraint `stores_active_location_chk` rechaza la
        // activación: la pantalla lo avisa antes de intentarlo.
        hasLocation: row.has_location === true,
        createdAt: toIsoString(row.created_at),
        approvedAt: row.approved_at ? toIsoString(row.approved_at) : null,
        memberCount: toNumber(row.member_count),
        productCount: toNumber(row.product_count),
        ownerEmail: (row.owner_email as string | null) ?? null,
      })),
    });
  } catch (error) {
    return platformErrorResponse(error);
  }
}

interface PatchBody {
  storeId?: unknown;
  active?: unknown;
}

export async function PATCH(request: Request) {
  const access = await requireAdminAccess(request);
  if (!access.ok) {
    return NextResponse.json({ error: access.message, code: access.code }, { status: access.status });
  }

  const body = await readJsonBody<PatchBody>(request);
  if (!body || typeof body.storeId !== 'string' || typeof body.active !== 'boolean') {
    return NextResponse.json(
      { error: 'Se requiere storeId (uuid) y active (boolean).', code: 'invalid_input' },
      { status: 400 },
    );
  }

  try {
    const sql = requirePlatformSql();
    const rows = await sql`
      UPDATE stores
         SET active = ${body.active},
             approved_at = CASE WHEN ${body.active} THEN COALESCE(approved_at, NOW()) ELSE approved_at END
       WHERE id = ${body.storeId}::uuid
       RETURNING id, name, slug, active, approved_at
    `;
    const row = (rows[0] ?? null) as Record<string, unknown> | null;
    if (!row) {
      return NextResponse.json({ error: 'Tienda no encontrada.', code: 'store_not_found' }, { status: 404 });
    }

    // Auditoría de la aprobación: quién la cambió, cuándo y desde dónde.
    // `approved_at` (columna) guarda el cuándo; este evento agrega el quién.
    logEvent('store_approval_changed', {
      storeId: String(row.id),
      active: row.active === true,
      adminUserId: access.userId ?? 'shared_admin_token',
      via: access.via ?? 'token',
      approvedAt: row.approved_at ? toIsoString(row.approved_at) : undefined,
    });

    return NextResponse.json({
      store: {
        id: String(row.id),
        name: String(row.name),
        slug: String(row.slug),
        active: row.active === true,
        approvedAt: row.approved_at ? toIsoString(row.approved_at) : null,
      },
    });
  } catch (error) {
    // Activar sin coordenadas viola `stores_active_location_chk`.
    if (error && typeof error === 'object' && (error as { code?: string }).code === '23514') {
      return NextResponse.json(
        {
          error: 'La tienda necesita latitud y longitud antes de activarse.',
          code: 'store_location_required',
        },
        { status: 400 },
      );
    }
    return platformErrorResponse(error);
  }
}
