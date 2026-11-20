/**
 * PATCH /api/merchant/stores/<storeId> — corrige la ubicación o la identidad
 * pública (nombre + dirección) de una tienda.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  QUÉ RECIBE (una cosa por petición)
 *
 *   1. UBICACIÓN
 *      { location: { ubigeo, address, reference?, latitude, longitude, source? } }
 *
 *      El cliente NO puede enviar department/province/district/city: esos
 *      nombres los deriva el trigger `stores_sync_ubigeo` a partir del UBIGEO.
 *      Aquí solo se validan la forma (lib/store-location.ts), la existencia del
 *      código en el catálogo INEI y que el pin caiga dentro del Perú.
 *
 *   2. IDENTIDAD
 *      { name?, slug? }
 *
 *      Solo para tiendas NUNCA publicadas (`active = FALSE`, `approved_at NULL`).
 *      La unicidad es case-insensitive (índice `uq_stores_slug`) y los slugs
 *      reservados los rechaza el trigger. El slug es solo la dirección pública:
 *      no describe ni cambia la ubicación de la tienda.
 *
 *  NO activa la tienda. La publicación sigue siendo exclusiva de Platform Admin
 *  (`PATCH /api/admin/stores`): son dos permisos distintos.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { NextResponse } from 'next/server';

import { getSessionUser } from '@/lib/auth.server';
import { getUbigeoChain } from '@/lib/geo/ubigeo.server';
import { logEvent } from '@/lib/observability.server';
import { platformErrorResponse, readJsonBody } from '@/lib/platform-api.server';
import { requirePlatformSql } from '@/lib/platform-db.server';
import { rateLimitGate } from '@/lib/rate-limit-http.server';
import {
  evaluatePinDistance,
  readFarPinConfirmation,
  validateStoreLocation,
} from '@/lib/store-location';
import {
  readStorePaymentsInput,
  requireStoreAccess,
  updateStoreContactPhone,
  updateStoreHours,
  updateStoreIdentity,
  updateStorePayments,
} from '@/lib/stores.server';
import { normalizeWhatsAppPhone } from '@/lib/whatsapp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PatchBody {
  location?: unknown;
  name?: unknown;
  slug?: unknown;
  contactPhone?: unknown;
  payments?: unknown;
  hours?: unknown;
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

  const gate = await rateLimitGate(request, 'merchant-store-update', {
    limit: 10,
    windowMs: 60_000,
    key: `merchant-store-update:${user.id}`,
  });
  if (gate) return gate;

  const body = await readJsonBody<PatchBody>(request);
  if (!body) {
    return NextResponse.json({ error: 'JSON inválido.', code: 'invalid_json' }, { status: 400 });
  }

  const hasLocation = body.location !== undefined && body.location !== null;
  const hasIdentity = body.name !== undefined || body.slug !== undefined;
  const hasContact = body.contactPhone !== undefined;
  const hasPayments = body.payments !== undefined;
  const hasHours = body.hours !== undefined;

  if (!hasLocation && !hasIdentity && !hasContact && !hasPayments && !hasHours) {
    return NextResponse.json(
      { error: 'No hay nada que actualizar.', code: 'invalid_store_input' },
      { status: 400 },
    );
  }

  if (
    (hasLocation && hasIdentity) ||
    (hasContact && (hasLocation || hasIdentity)) ||
    (hasPayments && (hasLocation || hasIdentity || hasContact)) ||
    (hasHours && (hasLocation || hasIdentity || hasContact || hasPayments))
  ) {
    return NextResponse.json(
      {
        error: 'Actualiza el WhatsApp, la ubicación o la dirección pública por separado.',
        code: 'invalid_store_input',
      },
      { status: 400 },
    );
  }

  if (hasPayments) {
    const payments = readStorePaymentsInput(body.payments);
    if (!payments) {
      return NextResponse.json(
        {
          error:
            'Revisa los números de Yape/Plin (6 a 20 caracteres) y el titular (máx. 80).',
          code: 'invalid_payments',
        },
        { status: 400 },
      );
    }

    try {
      const saved = await updateStorePayments(user.id, storeId, payments);
      logEvent('store_payments_updated', {
        storeId,
        userId: user.id,
        hasYape: saved.yape !== null,
        hasPlin: saved.plin !== null,
        cash: saved.cash,
      });
      return NextResponse.json({ payments: saved });
    } catch (error) {
      return platformErrorResponse(error);
    }
  }

  if (hasContact) {
    const raw = body.contactPhone;
    if (raw !== null && typeof raw !== 'string') {
      return NextResponse.json(
        { error: 'El WhatsApp debe ser texto.', code: 'invalid_phone' },
        { status: 400 },
      );
    }
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    const phone = trimmed ? normalizeWhatsAppPhone(trimmed) : null;
    if (trimmed && !phone) {
      return NextResponse.json(
        {
          error: 'Ingresa un WhatsApp válido de 9 dígitos (ej. 987 654 321).',
          code: 'invalid_phone',
        },
        { status: 400 },
      );
    }

    try {
      const store = await updateStoreContactPhone(user.id, storeId, phone);
      logEvent('store_contact_updated', {
        storeId,
        userId: user.id,
        hasPhone: phone !== null,
      });
      return NextResponse.json({
        store: {
          id: store.id,
          name: store.name,
          slug: store.slug,
          whatsapp: store.whatsapp,
        },
      });
    } catch (error) {
      return platformErrorResponse(error);
    }
  }

  if (hasHours) {
    const raw = body.hours;
    if (raw !== null && typeof raw !== 'string') {
      return NextResponse.json(
        { error: 'El horario debe ser texto.', code: 'invalid_hours' },
        { status: 400 },
      );
    }
    const rawHours = typeof raw === 'string' ? raw.trim() : '';
    if (rawHours.length > 120) {
      return NextResponse.json(
        { error: 'El horario no puede pasar de 120 caracteres.', code: 'invalid_hours' },
        { status: 400 },
      );
    }

    try {
      const saved = await updateStoreHours(user.id, storeId, rawHours || null);
      logEvent('store_hours_updated', {
        storeId,
        userId: user.id,
        hasHours: saved !== null,
      });
      return NextResponse.json({ hours: saved });
    } catch (error) {
      return platformErrorResponse(error);
    }
  }

  if (hasIdentity) {
    try {
      // `admin` como rol mínimo: owner y admin de la tienda pueden editarla.
      // Un usuario ajeno recibe 403/404 sin filtrar si la tienda existe.
      const store = await updateStoreIdentity(user.id, storeId, {
        name: body.name,
        slug: body.slug,
      });

      logEvent('store_identity_updated', {
        storeId,
        userId: user.id,
        slug: store.slug,
      });

      return NextResponse.json({
        store: {
          id: store.id,
          name: store.name,
          slug: store.slug,
          active: store.active,
          approvedAt: store.approvedAt,
        },
      });
    } catch (error) {
      return platformErrorResponse(error);
    }
  }

  const validation = validateStoreLocation(body.location);
  if (!validation.ok) {
    return NextResponse.json(
      { error: validation.message, code: validation.code, field: validation.field },
      { status: 400 },
    );
  }

  const location = validation.value;

  try {
    // `admin` como rol mínimo: owner y admin de la tienda pueden corregirla.
    // Un usuario ajeno recibe 403/404 sin filtrar si la tienda existe.
    await requireStoreAccess(user.id, storeId, 'admin');

    const chain = await getUbigeoChain(location.ubigeo);
    if (!chain) {
      return NextResponse.json(
        { error: 'El distrito elegido no existe en el catálogo.', code: 'ubigeo_not_found' },
        { status: 400 },
      );
    }

    // Guarda de cordura UBIGEO ↔ pin. Un centroide no son los límites del
    // distrito, pero a cientos de km el error es obvio: se confirma explícitamente
    // y no se guarda sin esa confirmación.
    const pin = evaluatePinDistance(
      chain.centroid,
      { latitude: location.latitude, longitude: location.longitude },
      { confirmed: readFarPinConfirmation(body?.location) },
    );
    if (pin.level !== 'ok') {
      return NextResponse.json(
        { error: pin.message, code: pin.code, field: 'pin' },
        { status: 400 },
      );
    }
    const warnings = [...validation.warnings, ...pin.warnings];

    const sql = requirePlatformSql();
    const rows = await sql`
      UPDATE stores
         SET address = ${location.address},
             reference = ${location.reference},
             ubigeo = ${location.ubigeo},
             latitude = ${location.latitude}::float8,
             longitude = ${location.longitude}::float8,
             location_source = ${location.source},
             location_updated_at = NOW(),
             updated_at = NOW()
       WHERE id = ${storeId}::uuid
       RETURNING id, slug, active, address, ubigeo, department, province, district,
                 reference, latitude, longitude, location_source
    `;

    const row = (rows[0] ?? null) as Record<string, unknown> | null;
    if (!row) {
      return NextResponse.json({ error: 'Tienda no encontrada.', code: 'store_not_found' }, { status: 404 });
    }

    logEvent('store_location_updated', {
      storeId,
      userId: user.id,
      source: location.source,
      source_country: 'pe',
      warnings: warnings.join(',') || 'none',
    });

    return NextResponse.json({
      store: {
        id: String(row.id),
        slug: String(row.slug),
        active: row.active === true,
        address: (row.address as string | null) ?? null,
        ubigeo: (row.ubigeo as string | null) ?? null,
        department: (row.department as string | null) ?? null,
        province: (row.province as string | null) ?? null,
        district: (row.district as string | null) ?? null,
        reference: (row.reference as string | null) ?? null,
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        locationSource: (row.location_source as string | null) ?? null,
      },
      warnings,
    });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
