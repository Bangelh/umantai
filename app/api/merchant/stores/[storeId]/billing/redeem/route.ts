import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth.server';
import { redeemPromotionForUser } from '@/lib/billing/promotions.server';
import { platformErrorResponse, readJsonBody } from '@/lib/platform-api.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ storeId: string }>;
}

interface Body {
  code?: unknown;
}

/** POST /api/merchant/stores/:storeId/billing/redeem — +N meses al período. */
export async function POST(request: Request, context: RouteContext) {
  const user = await getSessionUser(request.headers);
  if (!user) {
    return NextResponse.json({ error: 'Necesitas iniciar sesión.', code: 'not_authenticated' }, { status: 401 });
  }
  const body = await readJsonBody<Body>(request);
  const code = typeof body?.code === 'string' ? body.code.trim() : '';
  if (!code) {
    return NextResponse.json({ error: 'Ingresa un código promocional.', code: 'invalid_promotion_code' }, { status: 400 });
  }
  const { storeId } = await context.params;
  try {
    const billing = await redeemPromotionForUser(user.id, storeId, code);
    return NextResponse.json({ billing });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
