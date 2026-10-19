/**
 * GET /api/media/<object_key> — imagen pública del driver DB.
 *
 * La key la genera el servidor. Solo se sirven assets no archivados y con
 * MIME validado al subirlos. Cache inmutable: la key cambia si cambia la imagen.
 */

import { NextResponse } from 'next/server';
import { getMedia, isValidMediaKey } from '@/lib/storage.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ key: string[] }>;
}

export async function GET(_request: Request, context: RouteContext) {
  const { key: parts } = await context.params;
  const key = Array.isArray(parts) ? parts.join('/') : '';
  if (!isValidMediaKey(key)) {
    return NextResponse.json({ error: 'Imagen no encontrada.' }, { status: 404 });
  }

  try {
    const media = await getMedia(key);
    if (!media) {
      return NextResponse.json({ error: 'Imagen no encontrada.' }, { status: 404 });
    }
    return new NextResponse(Buffer.from(media.bytes) as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': media.mime,
        'Content-Length': String(media.bytes.byteLength),
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    console.error('[media] no se pudo leer el asset', error);
    return NextResponse.json({ error: 'Imagen no disponible.' }, { status: 500 });
  }
}
