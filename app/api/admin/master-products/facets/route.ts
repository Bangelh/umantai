import { NextResponse } from 'next/server';
import { requireAdminToken } from '@/lib/admin.server';
import { listMasterFacets } from '@/lib/master.server';
import { platformErrorResponse } from '@/lib/platform-api.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const access = requireAdminToken(request);
  if (!access.ok) {
    return NextResponse.json({ error: access.message, code: access.code }, { status: access.status });
  }
  try {
    return NextResponse.json(await listMasterFacets(), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
