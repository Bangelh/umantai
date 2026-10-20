import { NextResponse } from 'next/server';
import { requireAdminToken } from '@/lib/admin.server';
import { BillingError } from '@/lib/billing';
import { markSubscriptionPaymentFailed } from '@/lib/billing/subscriptions.server';
import { isProductionRuntime } from '@/lib/runtime-environment.server';
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
 * POST /api/admin/billing/subscriptions/:storeId/simulate-payment-failure
 *
 * Sólo staging/test con provider manual. Nunca existe en Producción ni con un
 * proveedor real. Simula active → past_due sin desactivar la tienda.
 */
export async function POST(request: Request, context: RouteContext) {
  const access = requireAdminToken(request);
  if (!access.ok) {
    return NextResponse.json({ error: access.message, code: access.code }, { status: access.status });
  }
  const provider = (process.env.BILLING_PROVIDER ?? 'manual').trim().toLowerCase();
  if (isProductionRuntime() || (provider && provider !== 'manual' && provider !== 'test')) {
    return NextResponse.json(
      { error: 'La simulación de fallo sólo existe en staging con provider manual.', code: 'not_allowed' },
      { status: 403 },
    );
  }
  const body = await readJsonBody<Body>(request);
  const { storeId } = await context.params;
  try {
    const billing = await markSubscriptionPaymentFailed({
      storeId,
      reason: typeof body?.reason === 'string' ? body.reason : 'staging_simulated_failure',
    });
    return NextResponse.json({ billing });
  } catch (error) {
    if (error instanceof BillingError) return platformErrorResponse(error);
    return platformErrorResponse(error);
  }
}
