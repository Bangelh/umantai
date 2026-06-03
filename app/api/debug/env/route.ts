import { NextResponse } from 'next/server';
import { getEnvDebugInfo } from '@/lib/env';

/**
 * GET /api/debug/env
 * Returns rich, sanitized environment diagnostics.
 * Intended for the /debug/env page and admin debugging.
 * All secrets and connection strings are masked.
 */
export async function GET() {
  try {
    const debug = getEnvDebugInfo();
    return NextResponse.json(debug, {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  } catch (error) {
    console.error('[debug/env] Failed to collect diagnostics:', error);
    return NextResponse.json(
      {
        error: 'Failed to collect environment diagnostics',
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
