import { NextRequest, NextResponse } from 'next/server';
import { getAllOverrides, hasDatabaseConnection } from '@/lib/db';
import { baseProductsData, type Product } from '@/lib/products';
import {
  COMMERCE_ERROR_MESSAGES,
  buildVariantKey,
  classifyCommerceError,
  isFulfillmentType,
  isOrderChannel,
  type CreateOrderLineInput,
  type ProductVariant,
  type ShippingAddress,
} from '@/lib/commerce';
import { createOrder, getOrderByPublicToken, isCommerceDbConfigured } from '@/lib/commerce.server';

/**
 * POST /api/orders — crea un pedido del carrito y reserva su stock.
 *
 * DECISIÓN DE SEGURIDAD IMPORTANTE
 *   El navegador SOLO manda `productSlug`, `quantity` y `variant`. El precio y el
 *   nombre los resuelve el servidor contra el catálogo (base + overrides de /admin).
 *   Mandar el precio desde el cliente es la forma clásica de que alguien "compre"
 *   un iPhone a S/ 1.00.
 *
 * Body:
 *   {
 *     idempotencyKey?: string,          // UUID que genera el carrito por intento de pago
 *     contactEmail: string,             // requerido
 *     contactPhone?: string,
 *     fullName?: string,
 *     docType?: 'DNI' | 'CE' | ...,     // se guarda en metadata para Mercado Pago
 *     docNumber?: string,
 *     channel?: 'web' | 'kiosk' | 'admin' | 'whatsapp',
 *     fulfillmentType: 'pickup_locker' | 'pickup_counter' | 'delivery',
 *     lockerCode?: string,
 *     customerNote?: string,
 *     shippingAddress?: ShippingAddress,   // requerido si fulfillmentType = 'delivery'
 *     shippingTotal?: number,
 *     items: [{ productSlug: string, quantity: number, variant?: { color?, storage? } }]
 *   }
 *
 * Respuestas: 201 con el pedido · 400 validación · 409 sin stock/transición inválida · 503 sin BD.
 *
 * Moneda: PEN (Soles). El negocio cobra con Yape/Plin vía Mercado Pago.
 */

/** TTL de la reserva de stock. Súbelo si el checkout real es más lento. */
const RESERVATION_TTL_MINUTES = (() => {
  const raw = Number(process.env.COMMERCE_RESERVATION_TTL_MINUTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
})();

/** Límite defensivo por línea (no hay tope en la BD; evita un carrito absurdo). */
const MAX_LINE_QUANTITY = 99;

interface OrderRequestBody {
  idempotencyKey?: unknown;
  contactEmail?: unknown;
  contactPhone?: unknown;
  fullName?: unknown;
  docType?: unknown;
  docNumber?: unknown;
  channel?: unknown;
  fulfillmentType?: unknown;
  lockerCode?: unknown;
  customerNote?: unknown;
  shippingAddress?: unknown;
  shippingTotal?: unknown;
  items?: unknown;
}

interface RawOrderLine {
  productSlug?: unknown;
  quantity?: unknown;
  variant?: unknown;
}

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Imagen de la línea: override de /admin si existe, si no la del catálogo base. */
function pickImage(override: Record<string, unknown>, base: Product): string | null {
  const overrideImages = override.images;
  if (Array.isArray(overrideImages) && typeof overrideImages[0] === 'string') {
    return overrideImages[0];
  }
  return base.images?.[0] ?? null;
}

export async function POST(request: NextRequest) {
  if (!hasDatabaseConnection() || !isCommerceDbConfigured()) {
    return NextResponse.json(
      { error: 'Database not configured. Run `vercel env pull .env.local` and apply db/migrations/001_commerce_core.sql.' },
      { status: 503 },
    );
  }

  let body: OrderRequestBody;
  try {
    body = (await request.json()) as OrderRequestBody;
  } catch {
    return badRequest('Invalid JSON body');
  }

  // ── Validación del contacto ────────────────────────────────────────────────
  const contactEmail = asTrimmedString(body.contactEmail)?.toLowerCase() ?? '';
  if (!contactEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
    return badRequest('A valid contactEmail is required');
  }

  const fulfillmentType = body.fulfillmentType;
  if (!isFulfillmentType(fulfillmentType)) {
    return badRequest('fulfillmentType must be one of: pickup_locker, pickup_counter, delivery');
  }

  const shippingAddress = (body.shippingAddress ?? null) as ShippingAddress | null;
  if (fulfillmentType === 'delivery' && !shippingAddress) {
    return badRequest('shippingAddress is required when fulfillmentType is "delivery"');
  }

  const rawItems = body.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return badRequest('items must be a non-empty array');
  }

  // ── Resolución de precios en el SERVIDOR ───────────────────────────────────
  // Una sola query para todos los overrides de /admin (no N queries).
  const overrides = await getAllOverrides();

  const lines: CreateOrderLineInput[] = [];

  for (const [index, raw] of rawItems.entries()) {
    const line = (raw ?? {}) as RawOrderLine;
    const productSlug = asTrimmedString(line.productSlug);
    if (!productSlug) return badRequest(`items[${index}].productSlug is required`);

    const base = baseProductsData.find((product) => product.slug === productSlug);
    if (!base) return badRequest(`Unknown product in items[${index}]: "${productSlug}"`);

    const quantity = Number(line.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_LINE_QUANTITY) {
      return badRequest(`items[${index}].quantity must be an integer between 1 and ${MAX_LINE_QUANTITY}`);
    }

    const override = (overrides[productSlug] ?? {}) as Record<string, unknown>;
    const overridePrice = override.price;
    const unitPrice =
      typeof overridePrice === 'number' && Number.isFinite(overridePrice) && overridePrice >= 0
        ? overridePrice
        : base.price;

    const variant: ProductVariant =
      line.variant && typeof line.variant === 'object' ? (line.variant as ProductVariant) : {};

    lines.push({
      productSlug,
      productName: typeof override.name === 'string' ? override.name : base.name,
      productBrand: typeof override.brand === 'string' ? override.brand : base.brand,
      imageUrl: pickImage(override, base),
      variant,
      // Clave de SKU compartida con `inventory`. Debe coincidir con lo que persiste
      // `order_items.variant_key`, o la reserva no encontraría el stock.
      variantKey: buildVariantKey(variant),
      quantity,
      unitPrice,
    });
  }

  // ── Metadata: datos del invitado + DNI para Mercado Pago ────────────────────
  // El pedido invitado no crea fila en `customers`; guardamos el snapshot de contacto
  // y el documento aquí. Fase 2 puede promoverlo a cliente registrado.
  const buyer: Record<string, string> = {};
  const fullName = asTrimmedString(body.fullName);
  const docType = asTrimmedString(body.docType);
  const docNumber = asTrimmedString(body.docNumber);
  const contactPhone = asTrimmedString(body.contactPhone);
  if (fullName) buyer.fullName = fullName;
  if (docType) buyer.docType = docType;
  if (docNumber) buyer.docNumber = docNumber;
  if (contactPhone) buyer.phone = contactPhone;

  const metadata: Record<string, unknown> = { channel: 'web_checkout' };
  if (Object.keys(buyer).length > 0) metadata.buyer = buyer;

  const idempotencyKey = asTrimmedString(body.idempotencyKey);
  const channel = isOrderChannel(body.channel) ? body.channel : 'web';
  const shippingTotal =
    typeof body.shippingTotal === 'number' && Number.isFinite(body.shippingTotal)
      ? body.shippingTotal
      : 0;

  try {
    const order = await createOrder(
      {
        idempotencyKey: idempotencyKey ?? undefined,
        contactEmail,
        contactPhone: contactPhone ?? null,
        channel,
        fulfillmentType,
        lockerCode: asTrimmedString(body.lockerCode),
        shippingAddress,
        customerNote: asTrimmedString(body.customerNote),
        currency: 'PEN',
        shippingTotal,
        reservationTtlMinutes: RESERVATION_TTL_MINUTES,
        items: lines,
      },
      { metadata },
    );

    return NextResponse.json({ order }, { status: 201 });
  } catch (error) {
    // El motor PL/pgSQL lanza con el código como texto: `insufficient_stock`, etc.
    const code = classifyCommerceError(error);

    if (code === 'insufficient_stock') {
      // 409 Conflict: el carrito es válido, pero el stock cambió bajo los pies
      // del comprador. El cliente debe re-leer disponibilidad y reintentar.
      return NextResponse.json(
        { error: COMMERCE_ERROR_MESSAGES[code], code },
        { status: 409 },
      );
    }

    if (code) {
      return NextResponse.json({ error: COMMERCE_ERROR_MESSAGES[code], code }, { status: 409 });
    }

    console.error('POST /api/orders error:', error);
    return NextResponse.json({ error: 'Failed to create order' }, { status: 500 });
  }
}

/**
 * GET /api/orders?token=<public_token>
 *
 * Lectura pública del pedido para la página de confirmación (`/pedido/<token>`).
 * Se usa el `public_token`, nunca el UUID interno: es un enlace que se le puede
 * pasar al comprador invitado sin filtrar identificadores de la base.
 */
export async function GET(request: NextRequest) {
  if (!hasDatabaseConnection() || !isCommerceDbConfigured()) {
    return NextResponse.json({ error: 'Database not configured' }, { status: 503 });
  }

  const token = asTrimmedString(request.nextUrl.searchParams.get('token'));
  if (!token) return badRequest('token query parameter is required');

  // Validación barata: evita mandar basura a Postgres con un cast ::uuid.
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(token)) return badRequest('token must be a valid UUID');

  try {
    const order = await getOrderByPublicToken(token);
    if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 });

    return NextResponse.json({ order });
  } catch (error) {
    console.error('GET /api/orders error:', error);
    return NextResponse.json({ error: 'Failed to load order' }, { status: 500 });
  }
}
