import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth.server';
import { getStoreBillingForUser } from '@/lib/billing/subscriptions.server';
import { isPlatformDbConfigured } from '@/lib/platform-db.server';
import { platformErrorResponse } from '@/lib/platform-api.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ storeId: string }>;
}

/** GET /api/merchant/stores/:storeId/billing — sólo owner/admin de ESA tienda. */
export async function GET(request: Request, context: RouteContext) {
  const user = await getSessionUser(request.headers);
  if (!user) {
    return NextResponse.json({ error: 'Necesitas iniciar sesión.', code: 'not_authenticated' }, { status: 401 });
  }
  if (!isPlatformDbConfigured()) {
    return NextResponse.json({ error: 'Base de datos no configurada.', code: 'db_not_configured' }, { status: 503 });
  }
  const { storeId } = await context.params;
  try {
    return NextResponse.json(
      { billing: await getStoreBillingForUser(user.id, storeId) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return platformErrorResponse(error);
  }
}
