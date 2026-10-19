/**
 * lib/analytics.server.ts — consultas del dashboard de analytics (solo servidor).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  DISEÑO
 *
 *  · UNA sola ronda de consultas por request: todas las agregaciones viajan en
 *    `sql.transaction([...], { readOnly: true })`. No hay N+1: no se pide nada
 *    por producto, por día ni por pedido.
 *  · Todo el dinero se agrega en Postgres como centavos enteros
 *    (`(total * 100)::bigint`): nunca se suman floats ni se redondea en JS.
 *  · Los buckets diarios/semanales se calculan en la zona comercial
 *    (`America/Lima`) con `AT TIME ZONE`, no en UTC.
 *  · Las consultas ya reciben `locationCode`. Cuando exista Multi-Tienda, el
 *    `store_id` se suma al WHERE de pedidos: la firma no cambia.
 *  · Solo lectura: este módulo no escribe ni crea tablas.
 *
 *  La regla de qué pedido es venta vive en `lib/analytics.ts` (pura y testeada);
 *  acá se traduce a los mismos enums, nunca a una lista distinta.
 */

import { createSqlClient, type SqlClient } from './db-driver.server';
import { getDatabaseUrl } from './db';
import {
  SALE_ORDER_STATUSES,
  SALE_PAYMENT_STATUSES,
  averageTicketCents,
  describeVariantKey,
  fillSeries,
  listDays,
  listIsoWeeks,
  percentChange,
  type AnalyticsKpis,
  type AnalyticsPoint,
  type AnalyticsStatusCount,
  type AnalyticsStockItem,
  type AnalyticsSummary,
  type AnalyticsTopProduct,
  type AnalyticsRange,
  type AnalyticsPreviousRange,
  type SeriesRow,
} from './analytics';
import { ORDER_STATUSES, type OrderStatus } from './commerce';
import { baseProductsData } from './products';

let cachedSql: SqlClient | null = null;

function getAnalyticsSql(): SqlClient | null {
  const url = getDatabaseUrl();
  if (!url) return null;
  if (!cachedSql) cachedSql = createSqlClient(url);
  return cachedSql;
}

export function isAnalyticsDbConfigured(): boolean {
  return !!getDatabaseUrl();
}

interface KpiRow {
  all_orders: number | string;
  sale_orders: number | string;
  revenue_cents: number | string | null;
  items_sold: number | string | null;
}

interface SeriesSqlRow {
  bucket: string;
  orders: number | string;
  revenue_cents: number | string | null;
}

interface StatusSqlRow {
  status: OrderStatus;
  count: number | string;
}

interface TopProductSqlRow {
  product_slug: string;
  product_name: string;
  quantity: number | string;
  revenue_cents: number | string | null;
}

interface StockSqlRow {
  product_slug: string;
  variant_key: string;
  quantity_available: number | string;
  reorder_point: number | string;
}

function toInt(value: number | string | null | undefined): number {
  const numeric = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function kpisFromRow(row: KpiRow | undefined): AnalyticsKpis {
  const revenueCents = toInt(row?.revenue_cents);
  const orders = toInt(row?.sale_orders);
  return {
    revenueCents,
    orders,
    averageTicketCents: averageTicketCents(revenueCents, orders),
    itemsSold: toInt(row?.items_sold),
    allOrders: toInt(row?.all_orders),
    cancelledOrders: 0,
  };
}

function seriesFromRows(rows: SeriesSqlRow[]): SeriesRow[] {
  return rows.map((row) => ({
    bucket: row.bucket,
    orders: toInt(row.orders),
    revenueCents: toInt(row.revenue_cents),
  }));
}

export interface AnalyticsOptions {
  range: AnalyticsRange;
  previous: AnalyticsPreviousRange;
  /** Local/locker del inventario. */
  locationCode?: string;
  /**
   * Scope de tienda. NULL/undefined = agregado global de la plataforma (panel
   * legacy). El panel de comerciante SIEMPRE pasa su storeId, ya validado por
   * `requireStoreAccess` antes de llegar acá.
   */
  storeId?: string | null;
  /** Reloj inyectable (tests). */
  now?: Date;
}

/**
 * Resumen completo del dashboard.
 *
 * `range` y `previous` ya vienen validados por `resolveAnalyticsRange()`; acá se
 * usan como parámetros de SQL, nunca se concatenan.
 */
export async function getAnalyticsSummary(options: AnalyticsOptions): Promise<AnalyticsSummary> {
  const sql = getAnalyticsSql();
  if (!sql) throw new Error('commerce_db_not_configured');

  const { range, previous } = options;
  const storeId = options.storeId ?? null;
  const locationCode = options.locationCode ?? 'MAIN';
  const generatedAt = (options.now ?? new Date()).toISOString();

  // Mismo predicado de venta en las 7 consultas: una sola definición.
  const results = await sql.transaction(
    [
      // 0 · KPIs del período
      sql`
        SELECT
          COUNT(*)::int AS all_orders,
          COUNT(*) FILTER (WHERE status = ANY(${SALE_ORDER_STATUSES as unknown as string[]}::order_status[]) AND payment_status = ANY(${SALE_PAYMENT_STATUSES as unknown as string[]}::payment_status[]))::int AS sale_orders,
          COALESCE(SUM((total * 100)::bigint) FILTER (WHERE status = ANY(${SALE_ORDER_STATUSES as unknown as string[]}::order_status[]) AND payment_status = ANY(${SALE_PAYMENT_STATUSES as unknown as string[]}::payment_status[])), 0)::bigint AS revenue_cents,
          COALESCE(SUM(item_count) FILTER (WHERE status = ANY(${SALE_ORDER_STATUSES as unknown as string[]}::order_status[]) AND payment_status = ANY(${SALE_PAYMENT_STATUSES as unknown as string[]}::payment_status[])), 0)::bigint AS items_sold
        FROM orders
         WHERE created_at >= ${range.fromUtc}::timestamptz
           AND created_at <  ${range.toUtc}::timestamptz
           AND (${storeId}::uuid IS NULL OR store_id = ${storeId}::uuid)
      `,
      // 1 · KPIs del período anterior (misma longitud)
      sql`
        SELECT
          COUNT(*)::int AS all_orders,
          COUNT(*) FILTER (WHERE status = ANY(${SALE_ORDER_STATUSES as unknown as string[]}::order_status[]) AND payment_status = ANY(${SALE_PAYMENT_STATUSES as unknown as string[]}::payment_status[]))::int AS sale_orders,
          COALESCE(SUM((total * 100)::bigint) FILTER (WHERE status = ANY(${SALE_ORDER_STATUSES as unknown as string[]}::order_status[]) AND payment_status = ANY(${SALE_PAYMENT_STATUSES as unknown as string[]}::payment_status[])), 0)::bigint AS revenue_cents,
          COALESCE(SUM(item_count) FILTER (WHERE status = ANY(${SALE_ORDER_STATUSES as unknown as string[]}::order_status[]) AND payment_status = ANY(${SALE_PAYMENT_STATUSES as unknown as string[]}::payment_status[])), 0)::bigint AS items_sold
        FROM orders
         WHERE created_at >= ${previous.fromUtc}::timestamptz
           AND created_at <  ${previous.toUtc}::timestamptz
           AND (${storeId}::uuid IS NULL OR store_id = ${storeId}::uuid)
      `,
      // 2 · Pedidos por estado (todos, no solo ventas)
      sql`
        SELECT status, COUNT(*)::int AS count
          FROM orders
         WHERE created_at >= ${range.fromUtc}::timestamptz
           AND created_at <  ${range.toUtc}::timestamptz
           AND (${storeId}::uuid IS NULL OR store_id = ${storeId}::uuid)
         GROUP BY status
      `,
      // 3 · Ventas por día comercial (Lima)
      sql`
        SELECT to_char((created_at AT TIME ZONE ${range.timeZone})::date, 'YYYY-MM-DD') AS bucket,
               COUNT(*)::int AS orders,
               COALESCE(SUM((total * 100)::bigint), 0)::bigint AS revenue_cents
          FROM orders
         WHERE created_at >= ${range.fromUtc}::timestamptz
           AND created_at <  ${range.toUtc}::timestamptz
           AND (${storeId}::uuid IS NULL OR store_id = ${storeId}::uuid)
           AND status = ANY(${SALE_ORDER_STATUSES as unknown as string[]}::order_status[])
           AND payment_status = ANY(${SALE_PAYMENT_STATUSES as unknown as string[]}::payment_status[])
         GROUP BY 1
         ORDER BY 1
      `,
      // 4 · Ventas por semana ISO (lunes), en la misma zona
      sql`
        SELECT to_char(date_trunc('week', created_at AT TIME ZONE ${range.timeZone}), 'YYYY-MM-DD') AS bucket,
               COUNT(*)::int AS orders,
               COALESCE(SUM((total * 100)::bigint), 0)::bigint AS revenue_cents
          FROM orders
         WHERE created_at >= ${range.fromUtc}::timestamptz
           AND created_at <  ${range.toUtc}::timestamptz
           AND (${storeId}::uuid IS NULL OR store_id = ${storeId}::uuid)
           AND status = ANY(${SALE_ORDER_STATUSES as unknown as string[]}::order_status[])
           AND payment_status = ANY(${SALE_PAYMENT_STATUSES as unknown as string[]}::payment_status[])
         GROUP BY 1
         ORDER BY 1
      `,
      // 5 · Top productos por ingresos (join, no N+1)
      sql`
        SELECT oi.product_slug,
               MAX(oi.product_name) AS product_name,
               SUM(oi.quantity)::bigint AS quantity,
               COALESCE(SUM((oi.line_total * 100)::bigint), 0)::bigint AS revenue_cents
          FROM order_items oi
          JOIN orders o ON o.id = oi.order_id
         WHERE o.created_at >= ${range.fromUtc}::timestamptz
           AND o.created_at <  ${range.toUtc}::timestamptz
           AND (${storeId}::uuid IS NULL OR o.store_id = ${storeId}::uuid)
           AND o.status = ANY(${SALE_ORDER_STATUSES as unknown as string[]}::order_status[])
           AND o.payment_status = ANY(${SALE_PAYMENT_STATUSES as unknown as string[]}::payment_status[])
         GROUP BY oi.product_slug
         ORDER BY revenue_cents DESC, quantity DESC
         LIMIT 10
      `,
      // 6 · Stock bajo / agotado: foto ACTUAL, no depende del rango
      sql`
        SELECT product_slug, variant_key, quantity_available, reorder_point
          FROM inventory
         WHERE location_code = ${locationCode}
           AND (${storeId}::uuid IS NULL OR store_id = ${storeId}::uuid)
           AND is_active = TRUE
           AND (
             quantity_available <= 0
             OR (reorder_point > 0 AND quantity_available <= reorder_point)
           )
         ORDER BY quantity_available ASC, product_slug, variant_key
         LIMIT 60
      `,
    ],
    { readOnly: true },
  );

  const current = kpisFromRow((results[0]?.[0] ?? undefined) as unknown as KpiRow | undefined);
  const prior = kpisFromRow((results[1]?.[0] ?? undefined) as unknown as KpiRow | undefined);

  const statusCounts = new Map<OrderStatus, number>();
  for (const row of (results[2] ?? []) as unknown as StatusSqlRow[]) {
    statusCounts.set(row.status, toInt(row.count));
  }
  const ordersByStatus: AnalyticsStatusCount[] = ORDER_STATUSES.map((status) => ({
    status,
    count: statusCounts.get(status) ?? 0,
  }));

  const daily = fillSeries(listDays(range.from, range.to), seriesFromRows((results[3] ?? []) as unknown as SeriesSqlRow[]));
  const weekly = fillSeries(listIsoWeeks(range.from, range.to), seriesFromRows((results[4] ?? []) as unknown as SeriesSqlRow[]));

  const topProducts: AnalyticsTopProduct[] = ((results[5] ?? []) as unknown as TopProductSqlRow[]).map(
    (row) => ({
      productSlug: row.product_slug,
      productName: row.product_name || row.product_slug,
      quantity: toInt(row.quantity),
      revenueCents: toInt(row.revenue_cents),
    }),
  );

  const productNames = new Map(baseProductsData.map((product) => [product.slug, product.name]));
  const lowStock: AnalyticsStockItem[] = [];
  const outOfStock: AnalyticsStockItem[] = [];
  for (const row of (results[6] ?? []) as unknown as StockSqlRow[]) {
    const available = Math.max(0, toInt(row.quantity_available));
    const item: AnalyticsStockItem = {
      productSlug: row.product_slug,
      productName: productNames.get(row.product_slug) ?? row.product_slug,
      variantKey: row.variant_key,
      variantLabel: describeVariantKey(row.variant_key),
      available,
      reorderPoint: toInt(row.reorder_point),
    };
    if (available <= 0) outOfStock.push(item);
    else lowStock.push(item);
  }

  const saleDaily: AnalyticsPoint[] = daily.map((row) => ({
    date: row.bucket,
    orders: row.orders,
    revenueCents: row.revenueCents,
  }));
  const saleWeekly: AnalyticsPoint[] = weekly.map((row) => ({
    date: row.bucket,
    orders: row.orders,
    revenueCents: row.revenueCents,
  }));

  // `cancelledOrders` incluye cancelados y expirados: es "pedidos perdidos",
  // no una venta que se cayó (nunca llegó a contarse).
  current.cancelledOrders = (statusCounts.get('cancelled') ?? 0) + (statusCounts.get('expired') ?? 0);

  return {
    range: {
      preset: range.preset,
      from: range.from,
      to: range.to,
      timeZone: range.timeZone,
      fromUtc: range.fromUtc,
      toUtc: range.toUtc,
      days: range.days,
    },
    previous: {
      from: previous.from,
      to: previous.to,
      revenueCents: prior.revenueCents,
      orders: prior.orders,
      averageTicketCents: prior.averageTicketCents,
    },
    sales: current,
    change: {
      revenuePct: percentChange(current.revenueCents, prior.revenueCents),
      ordersPct: percentChange(current.orders, prior.orders),
    },
    series: { daily: saleDaily, weekly: saleWeekly },
    ordersByStatus,
    topProducts,
    lowStock,
    outOfStock,
    rule: {
      countedStatuses: SALE_ORDER_STATUSES,
      excludedStatuses: ['pending_payment', 'cancelled', 'expired', 'refunded'],
      paymentStatuses: SALE_PAYMENT_STATUSES,
    },
    currency: 'PEN',
    generatedAt,
  };
}
