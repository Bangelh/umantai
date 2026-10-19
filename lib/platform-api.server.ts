/**
 * lib/platform-api.server.ts — errores de la capa de plataforma → HTTP.
 *
 * Un solo lugar decide el status y el shape del error. Las rutas no repiten
 * `if (error instanceof …)`.
 */

import { NextResponse } from 'next/server';
import { TenancyError } from './tenancy';

export function platformErrorResponse(error: unknown): NextResponse {
  if (error instanceof TenancyError) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: error.status },
    );
  }

  if (error instanceof Error && error.message === 'platform_db_not_configured') {
    return NextResponse.json(
      { error: 'Base de datos no configurada.', code: 'db_not_configured' },
      { status: 503 },
    );
  }

  if (error instanceof Error && error.message.startsWith('auth_')) {
    return NextResponse.json(
      { error: 'Autenticación no configurada en este entorno.', code: 'auth_not_configured' },
      { status: 503 },
    );
  }

  console.error('[platform] error no controlado', error);
  return NextResponse.json(
    { error: 'Error interno.', code: 'internal_error' },
    { status: 500 },
  );
}

/** Lee un JSON con límite defensivo de tamaño. */
export async function readJsonBody<T>(request: Request, maxBytes = 32_768): Promise<T | null> {
  const length = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(length) && length > maxBytes) return null;
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}
