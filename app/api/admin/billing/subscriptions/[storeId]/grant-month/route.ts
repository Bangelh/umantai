import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/admin.server';
import { grantFreeMonths } from '@/lib/billing/promotions.server';
import { platformErrorResponse, readJsonBody } from '@/lib/platform-api.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ storeId: string }>;
}

interface Body {
  months?: unknown;
  reason?: unknown;
}

/** POST /api/admin/billing/subscriptions/:storeId/grant-month */
export async function POST(request: Request, context: RouteContext) {
  const access = await requireAdminAccess(request);
  if (!access.ok) {
    return NextResponse.json({ error: access.message, code: access.code }, { status: access.status });
  }
  const body = await readJsonBody<Body>(request);
  const { storeId } = await context.params;
  try {
    const billing = await grantFreeMonths({
      storeId,
      months: typeof body?.months === 'number' ? body.months : 1,
      reason: typeof body?.reason === 'string' ? body.reason : 'platform_admin_grant',
    });
    return NextResponse.json({ billing });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
