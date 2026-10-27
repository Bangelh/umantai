import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/admin.server';
import { setPromotionActive } from '@/lib/billing/promotions.server';
import { platformErrorResponse, readJsonBody } from '@/lib/platform-api.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ promotionId: string }>;
}

interface Body {
  active?: unknown;
}

/** PATCH /api/admin/promotions/:promotionId — activar/desactivar código. */
export async function PATCH(request: Request, context: RouteContext) {
  const access = await requireAdminAccess(request);
  if (!access.ok) {
    return NextResponse.json({ error: access.message, code: access.code }, { status: access.status });
  }
  const body = await readJsonBody<Body>(request);
  if (!body || typeof body.active !== 'boolean') {
    return NextResponse.json({ error: 'active es obligatorio.', code: 'invalid_promotion' }, { status: 400 });
  }
  const { promotionId } = await context.params;
  try {
    return NextResponse.json({ promotion: await setPromotionActive(promotionId, body.active) });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
