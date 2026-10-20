import { NextResponse } from 'next/server';
import { requireAdminToken } from '@/lib/admin.server';
import { listAdminSubscriptions, listPlans } from '@/lib/billing/subscriptions.server';
import { platformErrorResponse } from '@/lib/platform-api.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/admin/billing/subscriptions — todas las tiendas + su plan/SKU. */
export async function GET(request: Request) {
  const access = requireAdminToken(request);
  if (!access.ok) {
    return NextResponse.json({ error: access.message, code: access.code }, { status: access.status });
  }
  try {
    const [subscriptions, plans] = await Promise.all([listAdminSubscriptions(), listPlans(true)]);
    return NextResponse.json(
      { subscriptions, plans },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return platformErrorResponse(error);
  }
}
