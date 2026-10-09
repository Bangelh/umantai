import { NextRequest, NextResponse } from 'next/server';
import { isCommerceDbConfigured } from '@/lib/commerce.server';
import {
  QA_CLEANUP_MAX_ORDER_IDS,
  checkQaCleanupAccess,
  runQaOrderCleanup,
} from '@/lib/qa-order-cleanup.server';

/**
 * POST /api/admin/orders/cancel — limpieza QA de pedidos. SOLO Preview.
 *
 * Cierra pedidos operativos que ensucian el kiosco (`confirmed` / `preparing` /
 * `ready_for_pickup`): libera su reserva por el motor de inventario, revoca su PIN y
 * los pasa a `cancelled`. NO borra nada: el pedido, sus líneas, `order_status_history`
 * y `inventory_movements` quedan completos.
 *
 * ─── CANDADOS (los tres a la vez, sin fallback) ──────────────────────────────
 *   1. `VERCEL_ENV === 'preview'`
 *   2. `QA_CLEANUP === '1'`
 *   3. autenticación administrativa (`x-admin-token`)
 *
 * Entorno o flag apagados → 404 (la ruta "no existe" en ese entorno).
 * Autenticación ausente o inválida → 403. Mismo cuerpo en ambos casos: no se revela
 * si la ruta está habilitada. Nunca se habilita por querystring/body.
 *
 * Body: `{ "orderIds": ["<uuid>", ...] }` — ÚNICAMENTE IDs explícitos.
 *   · No hay filtro por estado (nada de "cancelar todos los que estén en X").
 *   · No hay "cancel all". El alcance es exactamente lo que llega en el body.
 *
 * Respuesta: `{ ok, cancelled, alreadyCancelled, failed, results: [...] }`.
 * Un pedido que falla no revierte a los demás: cada uno tiene su propia transacción y
 * su resultado se reporta por ID.
 *
 * 200 procesado (con conteos) · 400 body inválido · 403 sin admin auth · 404 entorno/flag
 * 500 fallo inesperado · 503 sin base
 */
export async function POST(request: NextRequest) {
  // 0. Gate QA, ANTES de cualquier lectura: fail-closed y sin tocar la base.
  const access = checkQaCleanupAccess(request);
  if (!access.ok) {
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

  let body: { orderIds?: unknown };
  try {
    body = (await request.json()) as { orderIds?: unknown };
  } catch {
    return NextResponse.json(
      { ok: false, code: 'invalid_body', error: 'Solicitud inválida.' },
      { status: 400 },
    );
  }

  if (!Array.isArray(body.orderIds) || body.orderIds.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        code: 'invalid_order_ids',
        error: 'orderIds debe ser un arreglo no vacío de UUIDs explícitos.',
      },
      { status: 400 },
    );
  }

  if (body.orderIds.length > QA_CLEANUP_MAX_ORDER_IDS) {
    return NextResponse.json(
      {
        ok: false,
        code: 'too_many_order_ids',
        error: `Máximo ${QA_CLEANUP_MAX_ORDER_IDS} pedidos por llamada.`,
      },
      { status: 400 },
    );
  }

  const orderIds = [
    ...new Set(body.orderIds.map((value) => (typeof value === 'string' ? value.trim() : ''))),
  ];

  try {
    const summary = await runQaOrderCleanup(orderIds);

    console.info('[qa-order-cleanup] limpieza ejecutada', {
      requested: orderIds.length,
      cancelled: summary.cancelled,
      alreadyCancelled: summary.alreadyCancelled,
      failed: summary.failed,
    });

    return NextResponse.json({ ok: true, ...summary }, { status: 200 });
  } catch (error) {
    console.error('[qa-order-cleanup] la limpieza falló', error);
    return NextResponse.json(
      { ok: false, code: 'cleanup_failed', error: 'No se pudo ejecutar la limpieza.' },
      { status: 500 },
    );
  }
}
