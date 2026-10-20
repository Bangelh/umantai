import { NextResponse } from 'next/server';
import { requireAdminToken } from '@/lib/admin.server';
import { createPromotion, listPromotions } from '@/lib/billing/promotions.server';
import { platformErrorResponse, readJsonBody } from '@/lib/platform-api.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  code?: unknown;
  name?: unknown;
  description?: unknown;
  active?: unknown;
  durationMonths?: unknown;
  maxRedemptions?: unknown;
  planCode?: unknown;
  startsAt?: unknown;
  endsAt?: unknown;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** GET/POST /api/admin/promotions */
export async function GET(request: Request) {
  const access = requireAdminToken(request);
  if (!access.ok) {
    return NextResponse.json({ error: access.message, code: access.code }, { status: access.status });
  }
  try {
    return NextResponse.json({ promotions: await listPromotions() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return platformErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const access = requireAdminToken(request);
  if (!access.ok) {
    return NextResponse.json({ error: access.message, code: access.code }, { status: access.status });
  }
  const body = await readJsonBody<Body>(request);
  if (!body || typeof body.code !== 'string' || typeof body.name !== 'string') {
    return NextResponse.json(
      { error: 'code y name son obligatorios.', code: 'invalid_promotion' },
      { status: 400 },
    );
  }
  try {
    const promotion = await createPromotion({
      code: body.code,
      name: body.name,
      description: optionalString(body.description),
      active: body.active !== false,
      durationMonths: typeof body.durationMonths === 'number' ? body.durationMonths : 1,
      maxRedemptions:
        body.maxRedemptions === null || body.maxRedemptions === undefined
          ? null
          : Number(body.maxRedemptions),
      planCode: optionalString(body.planCode),
      startsAt: optionalString(body.startsAt),
      endsAt: optionalString(body.endsAt),
    });
    return NextResponse.json({ promotion }, { status: 201 });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
