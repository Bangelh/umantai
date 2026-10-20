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
  reason?: unknown;
}

/**
 * POST /api/merchant/stores/:storeId/billing/cancel
 * Por defecto `cancel_at_period_end = true`: conserva beneficios hasta el final.
 */
export async function POST(request: Request, context: RouteContext) {
  const user = await getSessionUser(request.headers);
  if (!user) {
    return NextResponse.json({ error: 'Necesitas iniciar sesión.', code: 'not_authenticated' }, { status: 401 });
  }
  const body = await readJsonBody<Body>(request);
  const { storeId } = await context.params;
  try {
    await requireStoreAccess(user.id, storeId, 'admin');
    const billing = await getBillingProvider().cancelSubscription({
      storeId,
      immediate: false,
      actorUserId: user.id,
      reason: typeof body?.reason === 'string' ? body.reason : 'merchant_cancel',
    });
    return NextResponse.json({ billing });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
