import { NextResponse } from 'next/server';
import { getAllOverrides } from '@/lib/db';

/**
 * GET /api/catalog/overrides — overrides publicados del catálogo (SOLO LECTURA).
 *
 * Es la versión pública de `/api/admin/overrides` (que quedó detrás de
 * `x-admin-token`). El sitio público necesita estos datos para mostrar
 * precio/nombre/imagen publicados desde `/admin`; antes los pedía al endpoint de
 * administración SIN token, recibía 401 y el precio publicado no llegaba nunca.
 *
 * No expone nada sensible: son los mismos campos editoriales del catálogo
 * (nombre, precio, imágenes, etc.). La ESCRITURA sigue exigiendo token de admin.
 *
 * Nota: `inStock` viaja por compatibilidad, pero NO es autoridad de stock — el
 * stock real lo publica `/api/catalog/availability` desde `inventory`.
 */
async function GET() {
  try {
    const overrides = await getAllOverrides();
    return NextResponse.json({ overrides });
  } catch (error) {
    console.error('GET /api/catalog/overrides error:', error);
    return NextResponse.json({ overrides: {}, error: 'Database error' }, { status: 500 });
  }
}

export { GET };
