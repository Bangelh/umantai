/**
 * GET/PATCH /api/account/profile — perfil básico del cliente.
 *
 * El nombre/email viven en `users` (Better Auth); los datos adicionales en
 * `customer_profiles`. No hay features sociales ni fidelización.
 */

import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth.server';
import { platformErrorResponse, readJsonBody } from '@/lib/platform-api.server';
import { getCustomerProfile, updateCustomerProfile } from '@/lib/stores.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function strOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function GET(request: Request) {
  const user = await getSessionUser(request.headers);
  if (!user) {
    return NextResponse.json(
      { error: 'Necesitas iniciar sesión.', code: 'not_authenticated' },
      { status: 401 },
    );
  }

  try {
    return NextResponse.json({ profile: await getCustomerProfile(user.id) });
  } catch (error) {
    return platformErrorResponse(error);
  }
}

interface ProfileBody {
  fullName?: unknown;
  phone?: unknown;
  docType?: unknown;
  docNumber?: unknown;
}

export async function PATCH(request: Request) {
  const user = await getSessionUser(request.headers);
  if (!user) {
    return NextResponse.json(
      { error: 'Necesitas iniciar sesión.', code: 'not_authenticated' },
      { status: 401 },
    );
  }

  const body = await readJsonBody<ProfileBody>(request);
  if (!body) {
    return NextResponse.json({ error: 'JSON inválido.', code: 'invalid_json' }, { status: 400 });
  }

  try {
    await updateCustomerProfile(user.id, {
      fullName: strOrNull(body.fullName),
      phone: strOrNull(body.phone),
      docType: strOrNull(body.docType),
      docNumber: strOrNull(body.docNumber),
    });
    return NextResponse.json({ profile: await getCustomerProfile(user.id) });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
