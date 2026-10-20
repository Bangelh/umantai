import { NextRequest, NextResponse } from 'next/server';
import { isAdminApiConfigured, requireAdminToken } from '@/lib/admin.server';
import { runBillingCycle } from '@/lib/billing/lifecycle.server';
import { getPrefixedEnv } from '@/lib/env';
import { isPlatformDbConfigured } from '@/lib/platform-db.server';

/**
 * GET /api/cron/billing — renovaciones, cancelaciones y expiraciones de PLANES.
 *
 * Separado de `/api/cron/expire-reservations` (pedidos). Se puede programar
 * aparte con `CRON_SECRET`. Es idempotente: cada transición comprueba el
 * período y los eventos tienen `idempotency_key` única.
 */
function isAuthorized(request: NextRequest): boolean {
  const cronSecret = (getPrefixedEnv('CRON_SECRET') ?? '').trim();
  if (cronSecret) return request.headers.get('authorization') === `Bearer ${cronSecret}`;
  if (requireAdminToken(request).ok) return true;
  return !isAdminApiConfigured();
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isPlatformDbConfigured()) {
    return NextResponse.json({ error: 'Database not configured' }, { status: 503 });
  }
  try {
    const result = await runBillingCycle();
    if (result.failed > 0) console.error('[cron] billing partial failures', result.errors);
    return NextResponse.json({ ok: result.failed === 0, ...result });
  } catch (error) {
    console.error('[cron] billing failed:', error);
    return NextResponse.json({ error: 'Could not run billing cycle' }, { status: 500 });
  }
}
