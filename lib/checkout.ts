/**
 * lib/checkout.ts — estado y resumen del checkout, puro y testeable.
 *
 * El carrito NO crea un pedido hasta que el usuario confirma en el paso explícito.
 * Esta máquina de estados es la que impide que un doble clic, un "Enter" repetido o
 * un evento tardío creen dos pedidos:
 *
 *   cart ──open──▶ confirming ──confirm──▶ submitting ──success──▶ created
 *                     │                        │
 *                   cancel                   failure
 *                     ▼                        ▼
 *                    cart                  confirming
 *
 * Cualquier evento fuera de esa tabla es un NO-OP (devuelve la misma fase). En
 * particular, `confirm` en `submitting` no vuelve a disparar la petición.
 */

export type CheckoutPhase = 'cart' | 'confirming' | 'submitting' | 'created';

export type CheckoutEvent =
  | 'open'
  | 'cancel'
  | 'confirm'
  | 'success'
  | 'failure'
  | 'reset';

export function transitionCheckout(phase: CheckoutPhase, event: CheckoutEvent): CheckoutPhase {
  switch (event) {
    case 'open':
      return phase === 'cart' ? 'confirming' : phase;
    case 'cancel':
      return phase === 'confirming' ? 'cart' : phase;
    case 'confirm':
      return phase === 'confirming' ? 'submitting' : phase;
    case 'success':
      return phase === 'submitting' ? 'created' : phase;
    case 'failure':
      return phase === 'submitting' ? 'confirming' : phase;
    case 'reset':
      return 'cart';
    default:
      return phase;
  }
}

/** ¿La fase actual permite disparar el POST de creación de pedido? */
export function canSubmitOrder(phase: CheckoutPhase): boolean {
  return phase === 'submitting';
}

/** Validación de contacto compartida por la UI (el servidor la repite). */
export function isValidContactEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export interface CheckoutSummaryInput {
  name: string;
  brand?: string | null;
  price: number;
  quantity: number;
  variant?: Record<string, string | null | undefined> | null;
}

export interface CheckoutSummaryLine {
  name: string;
  brand: string | null;
  variantLabel: string | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface CheckoutSummary {
  lines: CheckoutSummaryLine[];
  itemCount: number;
  subtotal: number;
  total: number;
}

/** Redondeo a centavos para no mostrar `0.30000000000000004`. */
export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Resumen que se muestra en el paso de confirmación. Solo presentación: el total
 * que vale es el que recalcula el servidor al crear el pedido.
 */
export function buildCheckoutSummary(items: readonly CheckoutSummaryInput[]): CheckoutSummary {
  const lines = items.map((item) => {
    const unitPrice = roundMoney(item.price);
    const variantLabel =
      Object.values(item.variant ?? {})
        .filter((value) => Boolean(value))
        .join(' · ') || null;

    return {
      name: item.name,
      brand: item.brand ?? null,
      variantLabel,
      quantity: item.quantity,
      unitPrice,
      lineTotal: roundMoney(unitPrice * item.quantity),
    };
  });

  const subtotal = roundMoney(lines.reduce((sum, line) => sum + line.lineTotal, 0));

  return {
    lines,
    itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
    subtotal,
    total: subtotal,
  };
}

export interface StockShortageView {
  productSlug: string;
  productName: string | null;
  variantKey: string;
  requested: number;
  available: number;
}

export interface ParsedOrderError {
  message: string;
  code: string | null;
  shortages: StockShortageView[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/**
 * Normaliza el error de `POST /api/orders`.
 *
 * El backend devuelve `{ error, code, details: { items: [...] } }` cuando falta
 * stock. La UI usa `shortages` para decir QUÉ SKU quedó corto y ofrecer volver al
 * carrito, en vez de un toast genérico.
 */
export function parseOrderErrorPayload(payload: unknown): ParsedOrderError {
  const root = asRecord(payload);
  const message =
    typeof root?.error === 'string' && root.error.trim()
      ? root.error
      : 'We could not place your order. Please try again.';
  const code = typeof root?.code === 'string' ? root.code : null;

  const details = asRecord(root?.details);
  const rawItems = Array.isArray(details?.items) ? details.items : [];

  const shortages: StockShortageView[] = [];
  for (const raw of rawItems) {
    const item = asRecord(raw);
    if (!item) continue;
    if (typeof item.productSlug !== 'string' || typeof item.variantKey !== 'string') continue;
    const requested = Number(item.requested);
    const available = Number(item.available);
    if (!Number.isFinite(requested) || !Number.isFinite(available)) continue;
    shortages.push({
      productSlug: item.productSlug,
      productName: typeof item.productName === 'string' ? item.productName : null,
      variantKey: item.variantKey,
      requested,
      available,
    });
  }

  return { message, code, shortages };
}
