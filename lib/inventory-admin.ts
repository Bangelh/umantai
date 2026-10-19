/**
 * lib/inventory-admin.ts — reglas puras del panel de inventario.
 *
 * Acá viven el estado visual (disponible / bajo / agotado), los filtros y la
 * validación de las entradas. Las rutas solo traducen esto a HTTP y llaman al
 * motor transaccional de `lib/commerce.server.ts`; la UI comparte las mismas
 * funciones para no mostrar algo distinto de lo que la API acepta.
 */

import {
  INVENTORY_MOVEMENT_TYPES,
  type InventoryItem,
  type InventoryMovementType,
} from './commerce';

export type InventoryStatus = 'available' | 'low' | 'out';

export interface AdminInventoryItem extends InventoryItem {
  productName: string;
  productBrand: string;
  /** Derivado de `quantity_available` + `reorder_point`. */
  status: InventoryStatus;
}

export interface CatalogIdentity {
  name: string;
  brand: string;
}

/**
 * Estado visual:
 *   · out → no queda nada disponible (aunque haya reservado).
 *   · low → disponible > 0 pero en o por debajo del umbral (`reorder_point`).
 *   · available → por encima del umbral o sin umbral configurado (0).
 *
 * `reorder_point = 0` significa "sin alerta", no "alerta en cero".
 */
export function inventoryStatusFor(quantityAvailable: number, reorderPoint: number): InventoryStatus {
  if (quantityAvailable <= 0) return 'out';
  if (reorderPoint > 0 && quantityAvailable <= reorderPoint) return 'low';
  return 'available';
}

export function toAdminInventoryItem(
  item: InventoryItem,
  product?: CatalogIdentity | null,
): AdminInventoryItem {
  return {
    ...item,
    productName: product?.name ?? item.productSlug,
    productBrand: product?.brand ?? '',
    status: inventoryStatusFor(item.quantityAvailable, item.reorderPoint),
  };
}

export interface InventoryFilters {
  q: string;
  status: InventoryStatus | 'all';
  variant: string;
}

export const EMPTY_INVENTORY_FILTERS: InventoryFilters = { q: '', status: 'all', variant: '' };

/** Filtra por nombre/marca/slug/variante y por estado visual. */
export function filterInventoryItems(
  items: readonly AdminInventoryItem[],
  filters: InventoryFilters,
): AdminInventoryItem[] {
  const q = filters.q.trim().toLowerCase();
  const variant = filters.variant.trim().toLowerCase();

  return items.filter((item) => {
    if (filters.status !== 'all' && item.status !== filters.status) return false;
    if (variant && !item.variantKey.toLowerCase().includes(variant)) return false;
    if (!q) return true;

    const haystack = [
      item.productName,
      item.productBrand,
      item.productSlug,
      item.variantKey,
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });
}

export interface InventorySummary {
  skuCount: number;
  unitsOnHand: number;
  unitsReserved: number;
  unitsAvailable: number;
  lowCount: number;
  outCount: number;
}

export function summarizeInventory(items: readonly AdminInventoryItem[]): InventorySummary {
  return items.reduce<InventorySummary>(
    (acc, item) => {
      acc.skuCount += 1;
      acc.unitsOnHand += item.quantityOnHand;
      acc.unitsReserved += item.quantityReserved;
      acc.unitsAvailable += item.quantityAvailable;
      if (item.status === 'low') acc.lowCount += 1;
      if (item.status === 'out') acc.outCount += 1;
      return acc;
    },
    {
      skuCount: 0,
      unitsOnHand: 0,
      unitsReserved: 0,
      unitsAvailable: 0,
      lowCount: 0,
      outCount: 0,
    },
  );
}

// =============================================================================
//  VALIDACIÓN DE ENTRADAS
// =============================================================================

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const MAX_QUANTITY = 100_000;
const MAX_REASON = 200;
const MAX_ACTOR = 80;
const MAX_IDEMPOTENCY = 120;
export const LEDGER_DEFAULT_LIMIT = 50;
export const LEDGER_MAX_LIMIT = 200;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalText(value: unknown): string | null {
  const parsed = text(value);
  return parsed ? parsed : null;
}

function parseActor(value: unknown): ValidationResult<string> {
  const actor = text(value);
  if (!actor) return { ok: true, value: 'admin' };
  if (actor.length < 2 || actor.length > MAX_ACTOR) {
    return { ok: false, error: `actor debe tener entre 2 y ${MAX_ACTOR} caracteres.` };
  }
  return { ok: true, value: actor };
}

function parseIdempotencyKey(value: unknown): ValidationResult<string | null> {
  const key = text(value);
  if (!key) return { ok: true, value: null };
  if (key.length > MAX_IDEMPOTENCY) {
    return { ok: false, error: `idempotencyKey no puede superar ${MAX_IDEMPOTENCY} caracteres.` };
  }
  return { ok: true, value: key };
}

export interface ReceiptInput {
  productSlug: string;
  variantKey: string;
  quantity: number;
  reason: string | null;
  actor: string;
  reorderPoint: number | null;
  idempotencyKey: string | null;
}

/**
 * Valida un ingreso de mercadería. El catálogo/variante se valida aparte porque
 * depende de `baseProductsData`; acá solo se valida la forma.
 */
export function parseReceiptInput(body: unknown): ValidationResult<ReceiptInput> {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Solicitud inválida.' };
  const input = body as Record<string, unknown>;

  const productSlug = text(input.productSlug);
  if (!productSlug) return { ok: false, error: 'productSlug es obligatorio.' };

  const variantKey = text(input.variantKey);

  const quantity = Number(input.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
    return { ok: false, error: `quantity debe ser un entero entre 1 y ${MAX_QUANTITY}.` };
  }

  const reason = optionalText(input.reason);
  if (reason && reason.length > MAX_REASON) {
    return { ok: false, error: `reason no puede superar ${MAX_REASON} caracteres.` };
  }

  const actor = parseActor(input.actor);
  if (!actor.ok) return actor;

  let reorderPoint: number | null = null;
  if (input.reorderPoint !== undefined && input.reorderPoint !== null && input.reorderPoint !== '') {
    const value = Number(input.reorderPoint);
    if (!Number.isInteger(value) || value < 0 || value > MAX_QUANTITY) {
      return { ok: false, error: `reorderPoint debe ser un entero entre 0 y ${MAX_QUANTITY}.` };
    }
    reorderPoint = value;
  }

  const idempotencyKey = parseIdempotencyKey(input.idempotencyKey);
  if (!idempotencyKey.ok) return idempotencyKey;

  return {
    ok: true,
    value: {
      productSlug,
      variantKey,
      quantity,
      reason,
      actor: actor.value,
      reorderPoint,
      idempotencyKey: idempotencyKey.value,
    },
  };
}

export interface AdjustmentInput {
  productSlug: string;
  variantKey: string;
  /** Firmado: + aumenta, − disminuye. Nunca 0. */
  delta: number;
  reason: string;
  actor: string;
  idempotencyKey: string | null;
}

/**
 * Valida un ajuste. `reason` es OBLIGATORIO: un cambio de stock sin explicación
 * no es auditable. El delta firmado evita el patrón leer→JS→escribir (la ruta
 * aplica el delta atómicamente y Postgres rechaza dejar `on_hand < reserved`).
 */
export function parseAdjustmentInput(body: unknown): ValidationResult<AdjustmentInput> {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Solicitud inválida.' };
  const input = body as Record<string, unknown>;

  const productSlug = text(input.productSlug);
  if (!productSlug) return { ok: false, error: 'productSlug es obligatorio.' };

  const variantKey = text(input.variantKey);

  const delta = Number(input.delta);
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > MAX_QUANTITY) {
    return {
      ok: false,
      error: `delta debe ser un entero distinto de 0, entre -${MAX_QUANTITY} y ${MAX_QUANTITY}.`,
    };
  }

  const reason = text(input.reason);
  if (reason.length < 3 || reason.length > MAX_REASON) {
    return { ok: false, error: `reason es obligatorio (3 a ${MAX_REASON} caracteres).` };
  }

  const actor = parseActor(input.actor);
  if (!actor.ok) return actor;

  const idempotencyKey = parseIdempotencyKey(input.idempotencyKey);
  if (!idempotencyKey.ok) return idempotencyKey;

  return {
    ok: true,
    value: {
      productSlug,
      variantKey,
      delta,
      reason,
      actor: actor.value,
      idempotencyKey: idempotencyKey.value,
    },
  };
}

export interface ThresholdInput {
  productSlug: string;
  variantKey: string;
  reorderPoint: number;
}

export function parseThresholdInput(body: unknown): ValidationResult<ThresholdInput> {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Solicitud inválida.' };
  const input = body as Record<string, unknown>;

  const productSlug = text(input.productSlug);
  if (!productSlug) return { ok: false, error: 'productSlug es obligatorio.' };

  const reorderPoint = Number(input.reorderPoint);
  if (!Number.isInteger(reorderPoint) || reorderPoint < 0 || reorderPoint > MAX_QUANTITY) {
    return { ok: false, error: `reorderPoint debe ser un entero entre 0 y ${MAX_QUANTITY}.` };
  }

  return {
    ok: true,
    value: { productSlug, variantKey: text(input.variantKey), reorderPoint },
  };
}

// =============================================================================
//  QUERY STRINGS
// =============================================================================

export interface InventoryListQuery {
  filters: InventoryFilters;
  limit: number;
}

export function parseInventoryListQuery(params: URLSearchParams): ValidationResult<InventoryListQuery> {
  const statusRaw = text(params.get('status')) || 'all';
  if (!['all', 'available', 'low', 'out'].includes(statusRaw)) {
    return { ok: false, error: 'status debe ser all, available, low u out.' };
  }

  const q = text(params.get('q'));
  if (q.length > 80) return { ok: false, error: 'q no puede superar 80 caracteres.' };

  const variant = text(params.get('variant'));
  if (variant.length > 80) return { ok: false, error: 'variant no puede superar 80 caracteres.' };

  const rawLimit = params.get('limit');
  let limit = 500;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
      return { ok: false, error: 'limit debe ser un entero entre 1 y 1000.' };
    }
    limit = parsed;
  }

  return {
    ok: true,
    value: {
      filters: { q, status: statusRaw as InventoryFilters['status'], variant },
      limit,
    },
  };
}

export interface LedgerQuery {
  productSlug: string | null;
  variantKey: string | null;
  movementType: InventoryMovementType | null;
  order: string | null;
  from: string | null;
  to: string | null;
  limit: number;
  offset: number;
}

function parseDateBoundary(value: string, endOfDay: boolean): string | null {
  if (!value) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = new Date(dateOnly ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(parsed.getTime())) return null;
  if (dateOnly && endOfDay) parsed.setUTCHours(23, 59, 59, 999);
  return parsed.toISOString();
}

/**
 * Filtros del ledger: producto, variante, tipo, pedido y rango de fechas.
 * `from`/`to` aceptan `YYYY-MM-DD` (día completo) o ISO 8601.
 */
export function parseLedgerQuery(params: URLSearchParams): ValidationResult<LedgerQuery> {
  const rawType = text(params.get('type'));
  if (rawType && !(INVENTORY_MOVEMENT_TYPES as readonly string[]).includes(rawType)) {
    return { ok: false, error: `type inválido. Valores: ${INVENTORY_MOVEMENT_TYPES.join(', ')}.` };
  }

  const rawFrom = text(params.get('from'));
  const rawTo = text(params.get('to'));
  const from = rawFrom ? parseDateBoundary(rawFrom, false) : null;
  if (rawFrom && !from) return { ok: false, error: 'from no es una fecha válida.' };
  const to = rawTo ? parseDateBoundary(rawTo, true) : null;
  if (rawTo && !to) return { ok: false, error: 'to no es una fecha válida.' };
  if (from && to && from > to) return { ok: false, error: 'from no puede ser posterior a to.' };

  const rawLimit = params.get('limit');
  let limit = LEDGER_DEFAULT_LIMIT;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > LEDGER_MAX_LIMIT) {
      return { ok: false, error: `limit debe ser un entero entre 1 y ${LEDGER_MAX_LIMIT}.` };
    }
    limit = parsed;
  }

  const rawOffset = params.get('offset');
  let offset = 0;
  if (rawOffset !== null) {
    const parsed = Number(rawOffset);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1_000_000) {
      return { ok: false, error: 'offset debe ser un entero mayor o igual que 0.' };
    }
    offset = parsed;
  }

  return {
    ok: true,
    value: {
      productSlug: optionalText(params.get('product')),
      variantKey: optionalText(params.get('variant')),
      movementType: (rawType as InventoryMovementType) || null,
      order: optionalText(params.get('order')),
      from,
      to,
      limit,
      offset,
    },
  };
}

export const MOVEMENT_TYPE_LABELS: Record<InventoryMovementType, string> = {
  receipt: 'Entrada',
  reservation: 'Reserva',
  reservation_release: 'Liberación',
  sale: 'Venta',
  adjustment: 'Ajuste',
  recount: 'Recuento',
  return: 'Devolución',
  shrinkage: 'Merma',
  transfer_in: 'Transferencia entrada',
  transfer_out: 'Transferencia salida',
};
