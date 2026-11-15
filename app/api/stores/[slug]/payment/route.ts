/**
 * GET /api/stores/:slug/payment — datos de pago públicos de una tienda.
 *
 * El carrito los pide al abrir la confirmación. Solo devuelve tiendas activas y
 * nunca expone membresías ni el resto de `stores.metadata`.
 */

import { NextResponse } from 'next/server';
import { getStorePaymentInfoBySlug } from '@/lib/stores.server';
import { validateStoreSlug } from '@/lib/tenancy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string }> },
) {
  const { slug } = await context.params;
  const check = validateStoreSlug(slug);
  if (!check.ok) {
    return NextResponse.json(
      { error: 'Tienda no encontrada.', code: 'store_not_found' },
      { status: 404 },
    );
  }

  const payments = await getStorePaymentInfoBySlug(check.slug);
  if (!payments) {
    return NextResponse.json(
      { error: 'Tienda no encontrada.', code: 'store_not_found' },
      { status: 404 },
    );
  }

  return NextResponse.json({ payments });
}
