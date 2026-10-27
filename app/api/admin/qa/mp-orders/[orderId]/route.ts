import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/admin.server';
import { isProductionRuntime } from '@/lib/runtime-environment.server';
import {
  MpOrdersApiError,
  fetchMpOrdersOrder,
  getMpOrdersAccessToken,
  isMpOrdersConfigured,
} from '@/lib/mercadopago-orders.server';

/**
 * GET /api/admin/qa/mp-orders/[orderId] — herramienta QA de INSPECCIÓN (read-only).
 *
 * Existe por una sola razón: poder MIRAR una Order que ya existe en Mercado Pago sin
 * copiar el access token fuera de Vercel. Hace UN único `GET /v1/orders/{id}` a
 * través del helper que ya usa el webhook (`fetchMpOrdersOrder`) y devuelve una vista
 * SANITIZADA: nunca la URL completa de checkout, nunca el email completo del
 * comprador, nunca el access token, nunca el webhook secret, nunca cabeceras.
 *
 * ─── CANDADOS (los tres, en orden, sin fallback) ─────────────────────────────
 *   1. Entorno NO productivo (fail-closed, decisión centralizada). En Producción la
 *      ruta "no existe": 404, sin revelar nada más.
 *   2. Autenticación administrativa (`x-admin-token`) → 401, o 503 si el servidor no
 *      tiene `ADMIN_API_SECRET` configurado (falla cerrado, nunca abierto).
 *   3. `MP_ORDERS_ACCESS_TOKEN` configurado → si falta, 503.
 *
 * El token de Mercado Pago se lee SOLO del servidor: no se acepta por query, body ni
 * por ningún header distinto del token admin (si el llamador lo intenta, 400).
 *
 * ─── SIN EFECTOS SECUNDARIOS ────────────────────────────────────────────────
 *  SOLO LECTURA: no crea Orders, no paga, no toca Preferences, no modifica el
 *  webhook, no escribe en `orders`, `inventory`, `inventory_movements` ni `pickup`,
 *  y no dispara notificaciones. Es una herramienta temporal de diagnóstico y se
 *  puede ELIMINAR sin afectar nada más.
 *
 * Respuestas: 200 vista sanitizada · 400 orderId o credenciales inválidas
 * · 401/503 auth admin · 404 fuera de entorno no productivo · 502 si Mercado Pago
 * rechaza la lectura (incluye su HTTP status y su código, ya sanitizados)
 * · 503 sin access token · 500 fallo inesperado.
 */

/** Formato básico de un id de Order: alfanumérico, sin barras ni puntos. */
const ORDER_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;

/**
 * Headers que JAMÁS son una fuente de credenciales para esta ruta.
 * El único header aceptado es el token admin (`x-admin-token`).
 */
const FORBIDDEN_CREDENTIAL_HEADERS = [
  'authorization',
  'x-access-token',
  'x-mp-access-token',
  'x-mp-orders-access-token',
  'x-orders-access-token',
] as const;

/** Parámetros de query que JAMÁS son una fuente de credenciales para esta ruta. */
const FORBIDDEN_CREDENTIAL_PARAMS = [
  'access_token',
  'mp_access_token',
  'api_key',
  'token',
] as const;

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

function fail(status: number, code: string, error: string) {
  return NextResponse.json({ ok: false, code, error }, { status, headers: NO_STORE });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orderId: string }> },
) {
  // ─── 1. Entorno (Producción = la ruta no existe) ────────────────────────────
  if (isProductionRuntime()) {
    return fail(404, 'qa_mp_orders_unavailable', 'No disponible.');
  }

  // ─── 2. Autenticación administrativa (401 / 503 sin ADMIN_API_SECRET) ───────
  const access = await requireAdminAccess(request);
  if (!access.ok) return fail(access.status, access.code, access.message);

  // ─── 3. Access token propio de la integración Orders (nunca el legacy) ──────
  if (!isMpOrdersConfigured()) {
    return fail(
      503,
      'mp_orders_not_configured',
      'Falta MP_ORDERS_ACCESS_TOKEN en el entorno del servidor.',
    );
  }

  // ─── 4. Ninguna credencial entra por otro canal ─────────────────────────────
  for (const header of FORBIDDEN_CREDENTIAL_HEADERS) {
    if (request.headers.get(header)) {
      return fail(
        400,
        'credentials_not_allowed',
        'Esta ruta no acepta credenciales en cabeceras: usa tu token admin.',
      );
    }
  }
  for (const param of FORBIDDEN_CREDENTIAL_PARAMS) {
    if (request.nextUrl.searchParams.has(param)) {
      return fail(
        400,
        'credentials_not_allowed',
        'Esta ruta no acepta credenciales por query: quedan en los logs.',
      );
    }
  }

  // ─── 5. Formato básico del id (antes de cualquier llamada a MP) ─────────────
  const { orderId } = await params;
  const requested = typeof orderId === 'string' ? orderId.trim() : '';
  if (!ORDER_ID_PATTERN.test(requested)) {
    return fail(400, 'invalid_order_id', 'orderId inválido.');
  }

  // ─── 6. UN único GET a la API de Orders ─────────────────────────────────────
  try {
    const order = await fetchMpOrdersOrder({
      orderId: requested,
      accessToken: getMpOrdersAccessToken(),
    });

    // Se registra el resultado de la lectura, sin secretos ni datos personales.
    console.info('[qa-mp-orders] inspected', {
      orderId: order.orderId,
      httpStatus: order.httpStatus,
      status: order.status,
      statusDetail: order.statusDetail,
      liveMode: order.liveMode,
      checkoutUrlPresent: order.checkoutUrlPresent,
      payments: order.payments.length,
    });

    return NextResponse.json(
      {
        ok: true,
        source: 'mercadopago-orders',
        httpStatus: order.httpStatus,
        mpRequestId: order.mpRequestId,
        id: order.orderId,
        type: order.type,
        status: order.status,
        statusDetail: order.statusDetail,
        externalReference: order.externalReference,
        totalAmount: order.totalAmount,
        totalPaidAmount: order.totalPaidAmount,
        createdDate: order.createdDate,
        lastUpdatedDate: order.lastUpdatedDate,
        expirationTime: order.expirationTime,
        processingMode: order.processingMode,
        countryCode: order.countryCode,
        currency: order.currency,
        userId: order.collectorId,
        liveMode: order.liveMode,
        applicationId: order.applicationId,
        modeFlags: order.modeFlags,
        checkoutUrlExists: order.checkoutUrlPresent,
        checkoutUrlHost: order.checkoutUrlHost,
        configOnline: order.configOnline,
        payer: {
          id: order.payerId,
          emailMasked: order.payerEmailMasked,
        },
        payments: order.payments,
        errors: null,
      },
      { status: 200, headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof MpOrdersApiError) {
      // Se registra lo que MP dijo, ya sanitizado y acotado por la librería.
      console.error('[qa-mp-orders] mercadopago rejected the read', {
        orderId: requested,
        httpStatus: error.httpStatus,
        mpCode: error.mpCode,
        detail: error.message,
        field: error.field,
        mpRequestId: error.mpRequestId,
      });
      return NextResponse.json(
        {
          ok: false,
          code: error.mpCode ?? 'mp_orders_api_error',
          error: 'Mercado Pago rechazó la lectura de la orden.',
          httpStatus: error.httpStatus,
          errors: {
            code: error.mpCode,
            detail: error.message,
            field: error.field,
            mpRequestId: error.mpRequestId,
          },
        },
        { status: 502, headers: NO_STORE },
      );
    }

    console.error('[qa-mp-orders] unexpected failure', error);
    return fail(500, 'mp_orders_unexpected_error', 'No se pudo leer la orden.');
  }
}
