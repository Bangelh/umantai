import { NextResponse } from 'next/server';
import { requireAdminToken } from '@/lib/admin.server';
import { listPlans } from '@/lib/billing/subscriptions.server';
import { platformErrorResponse } from '@/lib/platform-api.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/admin/plans — catálogo comercial visible para Platform Admin. */
export async function GET(request: Request) {
  const access = requireAdminToken(request);
  if (!access.ok) {
    return NextResponse.json({ error: access.message, code: access.code }, { status: access.status });
  }
  try {
    return NextResponse.json({ plans: await listPlans(true) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
