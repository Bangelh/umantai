import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/admin.server';
import { FREE_PLAN_CODE } from '@/lib/billing';
import { cancelStoreSubscription, changeStorePlan } from '@/lib/billing/subscriptions.server';
import { platformErrorResponse, readJsonBody } from '@/lib/platform-api.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ storeId: string }>;
}

interface Body {
  planCode?: unknown;
  effective?: unknown;
  reason?: unknown;
}

/** POST /api/admin/billing/subscriptions/:storeId/change-plan */
export async function POST(request: Request, context: RouteContext) {
  const access = await requireAdminAccess(request);
  if (!access.ok) {
    return NextResponse.json({ error: access.message, code: access.code }, { status: access.status });
  }
  const body = await readJsonBody<Body>(request);
  if (!body || typeof body.planCode !== 'string' || !body.planCode.trim()) {
    return NextResponse.json({ error: 'planCode es obligatorio.', code: 'invalid_plan' }, { status: 400 });
  }
  const { storeId } = await context.params;
  const planCode = body.planCode.trim().toLowerCase();
  const reason = typeof body.reason === 'string' ? body.reason : 'platform_admin_change_plan';

  try {
    if (planCode === FREE_PLAN_CODE) {
      return NextResponse.json({
        billing: await cancelStoreSubscription({ storeId, immediate: true, reason, source: 'admin' }),
      });
    }
    const billing = await changeStorePlan({
      storeId,
      planCode,
      effective: body.effective === 'period_end' ? 'period_end' : 'immediate',
      reason,
      source: 'admin',
    });
    return NextResponse.json({ billing });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
