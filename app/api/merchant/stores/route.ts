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
import { getSessionUser } from '@/lib/auth.server';
import { platformErrorResponse, readJsonBody } from '@/lib/platform-api.server';
import { isPlatformDbConfigured } from '@/lib/platform-db.server';
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

  try {
    const store = await createStoreForOwner({
      ownerUserId: user.id,
      name,
      slug: str(body.slug) ?? name,
      description: str(body.description),
      category: str(body.category),
      address: str(body.address),
      district: str(body.district),
      city: str(body.city),
      latitude: num(body.latitude),
      longitude: num(body.longitude),
      contactEmail: str(body.contactEmail) ?? user.email,
      contactPhone: str(body.contactPhone),
    });

    return NextResponse.json(
      {
        store,
        status: 'pending_approval',
        message: 'La tienda fue creada. Un administrador de UMANTAI debe activarla.',
      },
      { status: 201 },
    );
  } catch (error) {
    return platformErrorResponse(error);
  }
}
