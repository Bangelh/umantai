import { NextRequest, NextResponse } from 'next/server';
import { getVariantAvailability, isCommerceDbConfigured } from '@/lib/commerce.server';

/**
 * GET /api/catalog/availability?slug=<slug>  ·  ?slugs=a,b,c
 *
 * Disponibilidad real por variante, leída de `inventory` (la ÚNICA autoridad de
 * stock). El catálogo la usa para mostrar stock y deshabilitar combinaciones
 * agotadas; NUNCA decide una venta — eso lo hace la reserva transaccional en
 * `POST /api/orders`.
 *
 * Respuesta:
 *   { availability: { "<slug>": { variants: { "<variant_key>": <available> }, totalAvailable } } }
 *
 * `variant_key` es el mismo que comparten carrito, `order_items` y `inventory`
 * (`buildVariantKey()`); el producto sin variantes usa la clave `''`.
 *
 * 200 con datos · 400 sin slugs · 500 fallo inesperado · 503 sin base de datos.
 */

/** Tope defensivo: el catálogo público no necesita pedir más de 50 slugs de golpe. */
const MAX_SLUGS = 50;

async function GET(request: NextRequest) {
  if (!isCommerceDbConfigured()) {
    return NextResponse.json(
      { error: 'Inventory is not available in this environment.' },
      { status: 503 },
    );
  }

  const raw =
    request.nextUrl.searchParams.get('slugs') ??
    request.nextUrl.searchParams.get('slug') ??
    '';

  const slugs = [
    ...new Set(
      raw
        .split(',')
        .map((slug) => slug.trim())
        .filter((slug) => slug.length > 0),
    ),
  ].slice(0, MAX_SLUGS);

  if (slugs.length === 0) {
    return NextResponse.json({ error: 'Provide slug or slugs' }, { status: 400 });
  }

  try {
    const rows = await getVariantAvailability(slugs);

    const availability: Record<
      string,
      { variants: Record<string, number>; totalAvailable: number }
    > = {};
    for (const slug of slugs) availability[slug] = { variants: {}, totalAvailable: 0 };

    for (const row of rows) {
      const entry = availability[row.productSlug];
      if (!entry) continue;
      entry.variants[row.variantKey] = row.quantityAvailable;
      entry.totalAvailable += row.quantityAvailable;
    }

    return NextResponse.json(
      { availability },
      // El stock cambia con cada venta: que ningún intermediario lo cachee.
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('GET /api/catalog/availability error:', error);
    return NextResponse.json({ error: 'Could not load availability' }, { status: 500 });
  }
}

export { GET };
