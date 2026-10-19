/**
 * lib/analytics.ts — dominio de analytics del panel administrativo (puro).
 *
 * Sin React, sin base de datos, sin `process.env`: se puede usar en el servidor,
 * en el cliente y en los tests. La capa SQL vive en `lib/analytics.server.ts`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  REGLA DE VENTA (la parte que más fácil se equivoca)
 *
 *  Un pedido CUENTA como venta si:
 *    · su `status` es un estado con pago confirmado o posterior
 *      (`confirmed`, `preparing`, `ready_for_pickup`, `picked_up`,
 *       `out_for_delivery`, `delivered`, `completed`), y
 *    · su `payment_status` es `paid` o `partially_refunded`.
 *
 *  NO cuentan:
 *    · `pending_payment` → todavía no hay pago; solo retiene stock.
 *    · `cancelled` / `expired` → nunca hubo venta.
 *    · `refunded` → el dinero se devolvió; contarlo infla ingresos.
 *    · pagos `pending` / `failed` / `authorized` → autorizado no es cobrado.
 *
 *  Limitación conocida: `partially_refunded` se cuenta por el total original
 *  porque el esquema todavía no guarda el monto devuelto. Se documenta y se
 *  resolverá cuando exista devoluciones parciales reales.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  DINERO
 *
 *  Se trabaja SIEMPRE en centavos enteros. Postgres devuelve `NUMERIC` como
 *  string; `toCents("12.34")` lo convierte una sola vez y a partir de ahí solo
 *  hay sumas de enteros. Nunca se suman floats.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  ZONA HORARIA
 *
 *  El día comercial es el de Perú (`America/Lima`). "Hoy" significa hoy en Lima,
 *  no en UTC: a las 20:00 de Lima ya es el día siguiente en UTC y un dashboard
 *  que corte en UTC le corre el día al negocio. Los límites se convierten a
 *  instantes UTC con `Intl` (soporta DST aunque Lima no lo use).
 */

import type { OrderStatus, PaymentStatus } from './commerce';

// =============================================================================
//  1. REGLA DE VENTA
// =============================================================================

/** Estados cuyo pedido ya tiene pago confirmado (o pasó por ahí). */
export const SALE_ORDER_STATUSES = [
  'confirmed',
  'preparing',
  'ready_for_pickup',
  'picked_up',
  'out_for_delivery',
  'delivered',
  'completed',
] as const satisfies readonly OrderStatus[];

/** Estados que NUNCA son venta, con el motivo para el dashboard. */
export const NON_SALE_ORDER_STATUSES = [
  'pending_payment',
  'cancelled',
  'expired',
  'refunded',
] as const satisfies readonly OrderStatus[];

/** Estados de pago que respaldan una venta. */
export const SALE_PAYMENT_STATUSES = [
  'paid',
  'partially_refunded',
] as const satisfies readonly PaymentStatus[];

/** ¿Este pedido suma ingresos? Función única que usan SQL, tests y UI. */
export function isSaleOrder(status: OrderStatus, paymentStatus: PaymentStatus): boolean {
  return (
    (SALE_ORDER_STATUSES as readonly OrderStatus[]).includes(status) &&
    (SALE_PAYMENT_STATUSES as readonly PaymentStatus[]).includes(paymentStatus)
  );
}

/** Etiquetas para el panel (los valores del dominio no se traducen en la API). */
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  pending_payment: 'Pendiente de pago',
  confirmed: 'Confirmado',
  preparing: 'En preparación',
  ready_for_pickup: 'Listo para retiro',
  picked_up: 'Retirado',
  out_for_delivery: 'En camino',
  delivered: 'Entregado',
  completed: 'Completado',
  cancelled: 'Cancelado',
  expired: 'Expirado',
  refunded: 'Reembolsado',
};

/** Color semántico por estado (tokens de UI, no valores arbitrarios). */
export const ORDER_STATUS_TONE: Record<OrderStatus, 'info' | 'success' | 'warning' | 'danger' | 'muted'> = {
  pending_payment: 'warning',
  confirmed: 'info',
  preparing: 'info',
  ready_for_pickup: 'info',
  picked_up: 'success',
  out_for_delivery: 'info',
  delivered: 'success',
  completed: 'success',
  cancelled: 'danger',
  expired: 'muted',
  refunded: 'danger',
};

export const COMMERCE_TIME_ZONE = 'America/Lima';
export const COMMERCE_CURRENCY = 'PEN';

// =============================================================================
//  2. FECHAS (calendario local, sin `Date` ingenuo)
// =============================================================================

export type AnalyticsRangePreset = 'today' | '7d' | '30d' | 'custom';
export const ANALYTICS_RANGE_PRESETS: readonly AnalyticsRangePreset[] = ['today', '7d', '30d', 'custom'];

/** Tope del rango personalizado: 366 días (un año bisiesto). */
export const ANALYTICS_MAX_RANGE_DAYS = 366;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Valida `YYYY-MM-DD` de verdad (rechaza 2026-02-30, no solo el formato). */
export function isValidLocalDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function formatUtcDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseLocalDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

/** Suma (o resta) días a una fecha `YYYY-MM-DD` sin cruzar husos. */
export function addDays(value: string, days: number): string {
  const date = parseLocalDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return formatUtcDate(date);
}

/** Día de la semana ISO: 1 = lunes … 7 = domingo. */
export function isoWeekday(value: string): number {
  const day = parseLocalDate(value).getUTCDay(); // 0 = domingo
  return day === 0 ? 7 : day;
}

/** Lunes de la semana ISO que contiene `value`. */
export function startOfIsoWeek(value: string): string {
  return addDays(value, -(isoWeekday(value) - 1));
}

/** Fecha de hoy en la zona comercial (no en UTC). */
export function todayInTimeZone(now: Date = new Date(), timeZone = COMMERCE_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Offset de la zona en milisegundos para un instante dado (local − UTC).
 *
 * Se calcula con `Intl` en vez de asumir −05:00: hoy Lima no tiene DST, pero el
 * helper sirve para cualquier zona y no se rompe si eso cambia.
 */
function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    pick('year'),
    pick('month') - 1,
    pick('day'),
    pick('hour'),
    pick('minute'),
    pick('second'),
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Instante UTC de una hora local (`YYYY-MM-DD` + hora) en la zona indicada.
 *
 * Se corrige una vez con el offset del resultado para acertar en cambios de
 * horario (fuera de Lima, pero el helper queda correcto).
 */
export function zonedDateTimeToUtc(
  localDate: string,
  hour: number,
  timeZone = COMMERCE_TIME_ZONE,
): Date {
  const [year, month, day] = localDate.split('-').map(Number);
  const naiveUtc = Date.UTC(year, month - 1, day, hour, 0, 0, 0);
  const firstGuess = naiveUtc - timeZoneOffsetMs(new Date(naiveUtc), timeZone);
  const refined = naiveUtc - timeZoneOffsetMs(new Date(firstGuess), timeZone);
  return new Date(refined);
}

// =============================================================================
//  3. RANGOS
// =============================================================================

export interface AnalyticsRange {
  preset: AnalyticsRangePreset;
  /** Primer día comercial incluido (`YYYY-MM-DD`, hora Lima). */
  from: string;
  /** Último día comercial incluido (`YYYY-MM-DD`, hora Lima). */
  to: string;
  timeZone: string;
  /** Instante UTC inclusivo (00:00 de `from` en Lima). */
  fromUtc: string;
  /** Instante UTC EXCLUSIVO (00:00 del día siguiente a `to` en Lima). */
  toUtc: string;
  /** Días comerciales incluidos. */
  days: number;
}

export interface AnalyticsPreviousRange {
  from: string;
  to: string;
  fromUtc: string;
  toUtc: string;
}

export type RangeValidation =
  | { ok: true; range: AnalyticsRange; previous: AnalyticsPreviousRange }
  | { ok: false; error: string };

export interface ResolveRangeInput {
  preset?: string | null;
  from?: string | null;
  to?: string | null;
  /** Reloj inyectable para tests. */
  now?: Date;
  timeZone?: string;
}

/**
 * Traduce los parámetros del dashboard a un rango de calendario local + límites
 * UTC listos para SQL. `to` es inclusivo para el usuario y exclusivo en SQL.
 */
export function resolveAnalyticsRange(input: ResolveRangeInput = {}): RangeValidation {
  const timeZone = input.timeZone ?? COMMERCE_TIME_ZONE;
  const presetRaw = (input.preset ?? '').trim();
  const preset = (presetRaw || '30d') as AnalyticsRangePreset;
  if (!ANALYTICS_RANGE_PRESETS.includes(preset)) {
    return { ok: false, error: 'range debe ser today, 7d, 30d o custom.' };
  }

  const today = todayInTimeZone(input.now ?? new Date(), timeZone);
  let from: string;
  let to: string;

  if (preset === 'custom') {
    const rawFrom = (input.from ?? '').trim();
    const rawTo = (input.to ?? '').trim();
    if (!rawFrom || !rawTo) {
      return { ok: false, error: 'Para un rango personalizado envía from y to (YYYY-MM-DD).' };
    }
    if (!isValidLocalDate(rawFrom) || !isValidLocalDate(rawTo)) {
      return { ok: false, error: 'from y to deben ser fechas válidas en formato YYYY-MM-DD.' };
    }
    if (rawFrom > rawTo) {
      return { ok: false, error: 'from no puede ser posterior a to.' };
    }
    from = rawFrom;
    to = rawTo;
  } else {
    to = today;
    if (preset === 'today') from = today;
    else if (preset === '7d') from = addDays(today, -6);
    else from = addDays(today, -29);
  }

  const days = Math.round((parseLocalDate(to).getTime() - parseLocalDate(from).getTime()) / 86_400_000) + 1;
  if (days > ANALYTICS_MAX_RANGE_DAYS) {
    return {
      ok: false,
      error: `El rango no puede superar ${ANALYTICS_MAX_RANGE_DAYS} días.`,
    };
  }

  const range: AnalyticsRange = {
    preset,
    from,
    to,
    timeZone,
    fromUtc: zonedDateTimeToUtc(from, 0, timeZone).toISOString(),
    toUtc: zonedDateTimeToUtc(addDays(to, 1), 0, timeZone).toISOString(),
    days,
  };

  const previousTo = addDays(from, -1);
  const previousFrom = addDays(previousTo, -(days - 1));

  return {
    ok: true,
    range,
    previous: {
      from: previousFrom,
      to: previousTo,
      fromUtc: zonedDateTimeToUtc(previousFrom, 0, timeZone).toISOString(),
      toUtc: zonedDateTimeToUtc(addDays(previousTo, 1), 0, timeZone).toISOString(),
    },
  };
}

/** Todos los días comerciales del rango, en orden. */
export function listDays(from: string, to: string): string[] {
  const days: string[] = [];
  let cursor = from;
  while (cursor <= to) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return days;
}

/** Lunes de cada semana ISO tocada por el rango. */
export function listIsoWeeks(from: string, to: string): string[] {
  const weeks: string[] = [];
  let cursor = startOfIsoWeek(from);
  const last = startOfIsoWeek(to);
  while (cursor <= last) {
    weeks.push(cursor);
    cursor = addDays(cursor, 7);
  }
  return weeks;
}

// =============================================================================
//  4. DINERO Y MÉTRICAS
// =============================================================================

/**
 * Convierte dinero de Postgres (NUMERIC → string) a centavos enteros.
 * `null`/vacío → 0. Redondea al centavo más cercano.
 */
export function toCents(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(numeric * 100);
}

/** Ticket promedio en centavos. Con cero pedidos devuelve 0 (nunca NaN). */
export function averageTicketCents(revenueCents: number, orders: number): number {
  if (!Number.isFinite(revenueCents) || !Number.isFinite(orders) || orders <= 0) return 0;
  return Math.round(revenueCents / orders);
}

/** Variación porcentual contra el período anterior; `null` si no hay base. */
export function percentChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

export interface SeriesRow {
  bucket: string;
  orders: number;
  revenueCents: number;
}

/**
 * Completa los buckets sin datos con ceros.
 *
 * Un gráfico que salta los días sin ventas miente sobre la tendencia: el hueco
 * no se ve y la línea parece continua.
 */
export function fillSeries(buckets: readonly string[], rows: readonly SeriesRow[]): SeriesRow[] {
  const byBucket = new Map(rows.map((row) => [row.bucket, row]));
  return buckets.map(
    (bucket) => byBucket.get(bucket) ?? { bucket, orders: 0, revenueCents: 0 },
  );
}

/** `color:negro|storage:256` → `color: negro · storage: 256` (solo presentación). */
export function describeVariantKey(variantKey: string): string {
  const trimmed = (variantKey ?? '').trim();
  if (!trimmed) return 'Estándar';
  return trimmed
    .split('|')
    .map((part) => {
      const [key, ...rest] = part.split(':');
      const value = rest.join(':').trim();
      return value ? `${key.trim()}: ${value}` : key.trim();
    })
    .filter(Boolean)
    .join(' · ');
}

/** Formato de moneda para la UI (los datos siguen en centavos). */
export function formatMoney(cents: number, currency = COMMERCE_CURRENCY): string {
  const safe = Number.isFinite(cents) ? cents : 0;
  return new Intl.NumberFormat('es-PE', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(safe / 100);
}

/** `2026-10-19` → `19 oct` (para el eje del gráfico). */
export function formatShortDate(value: string): string {
  const date = parseLocalDate(value);
  return new Intl.DateTimeFormat('es-PE', {
    day: '2-digit',
    month: 'short',
    timeZone: 'UTC',
  }).format(date);
}

// =============================================================================
//  5. TIPOS DE RESPUESTA (los comparte API + UI)
// =============================================================================

export interface AnalyticsKpis {
  /** Ingresos del período, en centavos enteros. */
  revenueCents: number;
  /** Pedidos que cuentan como venta. */
  orders: number;
  averageTicketCents: number;
  itemsSold: number;
  /** Todos los pedidos creados en el período (incluye pendientes y cancelados). */
  allOrders: number;
  cancelledOrders: number;
}

export interface AnalyticsPoint {
  /** Día (`YYYY-MM-DD`) o lunes de la semana ISO. */
  date: string;
  orders: number;
  revenueCents: number;
}

export interface AnalyticsStatusCount {
  status: OrderStatus;
  count: number;
}

export interface AnalyticsTopProduct {
  productSlug: string;
  productName: string;
  quantity: number;
  revenueCents: number;
}

export interface AnalyticsStockItem {
  productSlug: string;
  productName: string;
  variantKey: string;
  variantLabel: string;
  /** Unidades disponibles (on_hand − reservado), nunca negativas. */
  available: number;
  reorderPoint: number;
}

export interface AnalyticsSummary {
  range: {
    preset: AnalyticsRangePreset;
    from: string;
    to: string;
    timeZone: string;
    fromUtc: string;
    toUtc: string;
    days: number;
  };
  previous: {
    from: string;
    to: string;
    revenueCents: number;
    orders: number;
    averageTicketCents: number;
  };
  sales: AnalyticsKpis;
  change: {
    revenuePct: number | null;
    ordersPct: number | null;
  };
  series: {
    daily: AnalyticsPoint[];
    weekly: AnalyticsPoint[];
  };
  ordersByStatus: AnalyticsStatusCount[];
  topProducts: AnalyticsTopProduct[];
  lowStock: AnalyticsStockItem[];
  outOfStock: AnalyticsStockItem[];
  rule: {
    countedStatuses: readonly OrderStatus[];
    excludedStatuses: readonly OrderStatus[];
    paymentStatuses: readonly PaymentStatus[];
  };
  currency: typeof COMMERCE_CURRENCY;
  generatedAt: string;
}
