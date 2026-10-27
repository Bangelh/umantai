import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/admin.server';
import { getStoreBillingView, listAdminEventsForStore } from '@/lib/billing/subscriptions.server';
import { platformErrorResponse } from '@/lib/platform-api.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ storeId: string }>;
}

/** GET /api/admin/billing/subscriptions/:storeId/history */
export async function GET(request: Request, context: RouteContext) {
  const access = await requireAdminAccess(request);
  if (!access.ok) {
    return NextResponse.json({ error: access.message, code: access.code }, { status: access.status });
  }
  const { storeId } = await context.params;
  try {
    const [billing, events] = await Promise.all([
      getStoreBillingView(storeId),
      listAdminEventsForStore(storeId, 100),
    ]);
    return NextResponse.json({ billing, events }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
