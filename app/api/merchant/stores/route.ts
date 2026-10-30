/**
 * /api/merchant/stores
 *
 *   GET  → tiendas a las que pertenece el usuario (una identidad puede tener
 *          varias) con su rol.
 *   POST → alta controlada: crea la tienda INACTIVA y asocia al usuario como
 *          `owner`. La DB le asigna Free 25 por trigger; no cobra nada.
 *
 * Autenticación: cookie de Better Auth. Sin sesión → 401.
 */

import { NextResponse } from 'next/server';
import { getSessionUser, resolveAuthBaseUrl } from '@/lib/auth.server';
import { buildStoreCreatedEmail, sendTransactionalEmail } from '@/lib/email.server';
import { getUbigeoChain } from '@/lib/geo/ubigeo.server';
import { platformErrorResponse, readJsonBody } from '@/lib/platform-api.server';
import { isPlatformDbConfigured } from '@/lib/platform-db.server';
import {
  evaluatePinDistance,
  readFarPinConfirmation,
  validateStoreLocation,
  type StoreLocationWarning,
} from '@/lib/store-location';
import { createStoreForOwner, listStoresForUser } from '@/lib/stores.server';
import { rateLimitGate } from '@/lib/rate-limit-http.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const user = await getSessionUser(request.headers);
  if (!user) {
    return NextResponse.json(
      { error: 'Necesitas iniciar sesión.', code: 'not_authenticated' },
      { status: 401 },
    );
  }
  if (!isPlatformDbConfigured()) {
    return NextResponse.json(
      { error: 'Base de datos no configurada.', code: 'db_not_configured' },
      { status: 503 },
    );
  }

  try {
    return NextResponse.json({ stores: await listStoresForUser(user.id) });
  } catch (error) {
    return platformErrorResponse(error);
  }
}

interface CreateStoreBody {
  name?: unknown;
  slug?: unknown;
  description?: unknown;
  category?: unknown;
  /** Ubicación estructurada (flujo nuevo). */
  location?: unknown;
  /** Campos legacy: se aceptan mientras haya clientes antiguos. */
  address?: unknown;
  district?: unknown;
  city?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  contactEmail?: unknown;
  contactPhone?: unknown;
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function POST(request: Request) {
  const user = await getSessionUser(request.headers);
  if (!user) {
    return NextResponse.json(
      { error: 'Necesitas iniciar sesión.', code: 'not_authenticated' },
      { status: 401 },
    );
  }

  // Onboarding: 5 altas por hora y usuario. Evita crear tiendas en bucle.
  const gate = await rateLimitGate(request, 'merchant-onboarding', {
    limit: 5,
    windowMs: 60 * 60_000,
    key: `onboarding:${user.id}`,
  });
  if (gate) return gate;

  const body = await readJsonBody<CreateStoreBody>(request);
  if (!body) {
    return NextResponse.json({ error: 'JSON inválido.', code: 'invalid_json' }, { status: 400 });
  }

  const name = str(body.name);
  if (!name) {
    return NextResponse.json(
      { error: 'El nombre del negocio es obligatorio.', code: 'invalid_store_input' },
      { status: 400 },
    );
  }

  // Ubicación estructurada: si viene, manda. Se valida ANTES de crear la tienda
  // para no dejar una fila a medio llenar si el payload es inválido.
  let structured: {
    ubigeo: string;
    address: string;
    reference: string | null;
    latitude: number;
    longitude: number;
    source: 'map_pin' | 'gps' | 'geocoder' | 'legacy_zone';
  } | null = null;
  const warnings: StoreLocationWarning[] = [];

  if (body.location !== undefined && body.location !== null) {
    const validation = validateStoreLocation(body.location);
    if (!validation.ok) {
      return NextResponse.json(
        { error: validation.message, code: validation.code, field: validation.field },
        { status: 400 },
      );
    }
    if (isPlatformDbConfigured()) {
      const chain = await getUbigeoChain(validation.value.ubigeo).catch(() => null);
      if (!chain) {
        return NextResponse.json(
          { error: 'El distrito elegido no existe en el catálogo.', code: 'ubigeo_not_found' },
          { status: 400 },
        );
      }
      // Misma guarda que en la edición: lejos → confirmación explícita;
      // a cientos de km → no se crea la tienda.
      const pin = evaluatePinDistance(
        chain.centroid,
        { latitude: validation.value.latitude, longitude: validation.value.longitude },
        { confirmed: readFarPinConfirmation(body.location) },
      );
      if (pin.level !== 'ok') {
        return NextResponse.json(
          { error: pin.message, code: pin.code, field: 'pin' },
          { status: 400 },
        );
      }
      warnings.push(...validation.warnings, ...pin.warnings);
    }
    structured = validation.value;
  }

  try {
    const store = await createStoreForOwner({
      ownerUserId: user.id,
      name,
      slug: str(body.slug) ?? name,
      description: str(body.description),
      category: str(body.category),
      address: structured?.address ?? str(body.address),
      ubigeo: structured?.ubigeo ?? null,
      reference: structured?.reference ?? null,
      locationSource: structured?.source ?? null,
      // Con UBIGEO los nombres los deriva la base: no se escriben desde acá.
      district: structured ? null : str(body.district),
      city: structured ? null : str(body.city),
      latitude: structured?.latitude ?? num(body.latitude),
      longitude: structured?.longitude ?? num(body.longitude),
      contactEmail: str(body.contactEmail) ?? user.email,
      contactPhone: str(body.contactPhone),
    });

    // Aviso por correo: 'store created' es parte del producto (el comerciante
    // necesita saber que el alta funcionó y qué sigue). Es best-effort: si el
    // correo falla, la tienda YA existe y la respuesta lo dice explícitamente
    // para que la UI no deje al usuario con la duda.
    const email = await sendTransactionalEmail(
      buildStoreCreatedEmail(user.email, {
        storeName: store.name,
        slug: store.slug,
        panelUrl: `${resolveAuthBaseUrl()}/negocio/${store.id}`,
        requiresVerification: !user.emailVerified,
      }),
    ).catch((error: unknown) => ({ status: 'failed' as const, reason: String(error) }));

    console.info('[merchant-onboarding] tienda creada', {
      storeId: store.id,
      emailStatus: email.status,
      ...(email.status === 'failed' ? { emailReason: email.reason } : {}),
    });

    return NextResponse.json(
      {
        store,
        status: 'pending_approval',
        warnings,
        email: { status: email.status, to: user.email },
        message: 'La tienda fue creada. Un administrador de UMANTAI debe activarla.',
      },
      { status: 201 },
    );
  } catch (error) {
    return platformErrorResponse(error);
  }
}
