import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth.server';
import { getBillingProvider } from '@/lib/billing/provider.server';
import { requireStoreAccess } from '@/lib/stores.server';
import { platformErrorResponse, readJsonBody } from '@/lib/platform-api.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ storeId: string }>;
}

interface Body {
  planCode?: unknown;
  effective?: unknown;
}

/** POST /api/merchant/stores/:storeId/billing/change-plan */
export async function POST(request: Request, context: RouteContext) {
  const user = await getSessionUser(request.headers);
  if (!user) {
    return NextResponse.json({ error: 'Necesitas iniciar sesión.', code: 'not_authenticated' }, { status: 401 });
  }
  const body = await readJsonBody<Body>(request);
  if (!body || typeof body.planCode !== 'string' || !body.planCode.trim()) {
    return NextResponse.json({ error: 'planCode es obligatorio.', code: 'invalid_plan' }, { status: 400 });
  }
  const effective = body.effective === 'period_end' ? 'period_end' : 'immediate';

  const { storeId } = await context.params;
  try {
    await requireStoreAccess(user.id, storeId, 'admin');
    const billing = await getBillingProvider().changePlan({
      storeId,
      planCode: body.planCode.trim(),
      effective,
      actorUserId: user.id,
      reason: 'merchant_change_plan',
    });
    return NextResponse.json({ billing });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
