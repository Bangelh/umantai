import { NextRequest, NextResponse } from 'next/server';
import { isCommerceDbConfigured } from '@/lib/commerce.server';
import { checkPaymentSimulationAccess, runPaymentSimulation } from '@/lib/payment-simulation.server';

/**
 * POST /api/admin/qa/simulate-payment — SOLO QA, SOLO Preview.
 *
 * Simula que Mercado Pago aprobó un pago y ejecuta el MISMO flujo interno que
 * ejecutaría un webhook legítimo (`applyApprovedPayment`): confirmado, reglas de
 * stock, notificaciones. No hace ningún UPDATE directo de `orders` y no toca
 * Mercado Pago.
 *
 * ─── CANDADOS (los tres a la vez, sin fallback) ──────────────────────────────
 *   1. `VERCEL_ENV === 'preview'`
 *   2. `MP_PAYMENT_SIMULATION === '1'`
 *   3. autenticación administrativa (`x-admin-token`)
 *
 * Si el entorno o el flag no están → 404 (la ruta no existe para ese entorno).
 * Si la autenticación administrativa falla → 403. Nunca se habilita por
 * querystring/body ni en Producción.
 *
 * Body: `{ orderId: string }` — ES EL ÚNICO DATO. El monto, la moneda y el
 * resultado se leen del pedido real del servidor; el cliente no puede indicarlos.
 *
 * 200 simulado (o no-op idempotente) · 400 body inválido · 403 sin admin auth
 * 404 entorno/flag apagados o pedido inexistente · 500 fallo inesperado · 503 sin base
 */
export async function POST(request: NextRequest) {
  // 0. Gate QA, ANTES de cualquier lectura: fail-closed y sin tocar la base.
  const access = checkPaymentSimulationAccess(request);
  if (!access.ok) {
    // Mismo cuerpo para "no existe" (404) y "no autorizado" (403): no se revela si
    // la ruta está habilitada en este entorno.
    return NextResponse.json(
      { ok: false, code: access.code, error: 'No disponible.' },
      { status: access.status },
    );
  }

  if (!isCommerceDbConfigured()) {
    return NextResponse.json(
      { ok: false, code: 'database_not_configured', error: 'La base de datos no está configurada.' },
      { status: 503 },
    );
  }

  let body: { orderId?: unknown };
  try {
    body = (await request.json()) as { orderId?: unknown };
  } catch {
    return NextResponse.json(
      { ok: false, code: 'invalid_body', error: 'Solicitud inválida.' },
      { status: 400 },
    );
  }

  const orderId = typeof body.orderId === 'string' ? body.orderId.trim() : '';
  // Validación barata antes del cast ::uuid de Postgres.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) {
    return NextResponse.json(
      { ok: false, code: 'invalid_order_id', error: 'Pedido inválido.' },
      { status: 400 },
    );
  }

  try {
    const result = await runPaymentSimulation(orderId);

    if (!result.ok) {
      return NextResponse.json(
        { ok: false, code: 'order_not_found', error: 'El pedido no existe.' },
        { status: 404 },
      );
    }

    // Deja constancia en logs/auditoría de que esto NO es un pago de Mercado Pago.
    console.info('[qa-simulate-payment] pago simulado aplicado', {
      orderId: result.orderId,
      orderNumber: result.orderNumber,
      simulationId: result.simulationId,
      previousStatus: result.previousStatus,
      status: result.status,
      paymentStatus: result.paymentStatus,
      applied: result.applied,
      idempotentReason: result.idempotentReason,
      fulfillmentBlocked: result.fulfillmentBlocked,
      storeNotified: result.storeNotified,
      source: result.source,
    });

    return NextResponse.json(
      {
        ok: true,
        order: {
          id: result.orderId,
          orderNumber: result.orderNumber,
          previousStatus: result.previousStatus,
          status: result.status,
          previousPaymentStatus: result.previousPaymentStatus,
          paymentStatus: result.paymentStatus,
        },
        simulationId: result.simulationId,
        applied: result.applied,
        idempotentReason: result.idempotentReason,
        fulfillmentBlocked: result.fulfillmentBlocked,
        storeNotified: result.storeNotified,
        source: result.source,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error('[qa-simulate-payment] no se pudo simular el pago', { orderId, error });
    return NextResponse.json(
      { ok: false, code: 'simulation_failed', error: 'No se pudo simular el pago.' },
      { status: 500 },
    );
  }
}
