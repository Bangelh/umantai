/**
 * lib/whatsapp.server.ts — aviso de pedido nuevo al WhatsApp de la tienda.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  QUÉ HACE
 *
 *  Cuando el comprador crea un pedido, la tienda recibe un WhatsApp con el
 *  número, el total y el enlace directo al pedido en su panel. Es BEST-EFFORT:
 *  el pedido ya existe y la reserva ya está hecha; un WhatsApp caído no puede
 *  revertir la venta.
 *
 *  ─── PARA QUÉ SIRVE HOY ─────────────────────────────────────────────────────
 *  Sin credenciales configuradas devuelve `not_configured` y no hace nada: el
 *  comprador igual ve el botón "Avisar a la tienda por WhatsApp" en su pedido,
 *  que abre WhatsApp con el mensaje ya escrito. Ese camino funciona sin
 *  proveedor y es el que se usa en staging.
 *
 *  ─── ACTIVAR EL ENVÍO AUTOMÁTICO ────────────────────────────────────────────
 *  WhatsApp Cloud API (Meta), sin SDK:
 *
 *    WHATSAPP_ACCESS_TOKEN       token permanente de la app de Meta
 *    WHATSAPP_PHONE_NUMBER_ID    id del número emisor (no el teléfono)
 *
 *  El destinatario sale de `stores.contact_phone`, nunca del entorno: cada
 *  tienda recibe en SU número. Un número inválido devuelve `no_phone` y no se
 *  inventa un destinatario.
 */

import { getPrefixedEnv } from './env';
import { normalizeWhatsAppPhone } from './whatsapp';
import { requirePlatformSql } from './platform-db.server';

export type StoreWhatsAppStatus =
  | 'sent'
  | 'not_configured'
  | 'no_phone'
  | 'order_not_found'
  | 'failed';

const GRAPH_VERSION = 'v21.0';
const SEND_TIMEOUT_MS = 5_000;

function readEnv(key: string): string {
  return (getPrefixedEnv(key) ?? '').trim();
}

function appBaseUrl(): string {
  const raw =
    readEnv('NEXT_PUBLIC_APP_URL') ||
    (process.env.NEXT_PUBLIC_APP_URL ?? '').trim() ||
    (process.env.NEXT_PUBLIC_SITE_URL ?? '').trim();
  return (raw || 'https://umantai.com').replace(/\/+$/, '');
}

/** Avisa a la tienda de un pedido recién creado. NUNCA lanza. */
async function sendText(to: string, message: string, orderId: string): Promise<StoreWhatsAppStatus> {
  const token = readEnv('WHATSAPP_ACCESS_TOKEN');
  const phoneNumberId = readEnv('WHATSAPP_PHONE_NUMBER_ID');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body: message },
        }),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      console.error('[whatsapp] Meta rechazó el aviso', { orderId, status: response.status });
      return 'failed';
    }
    return 'sent';
  } finally {
    clearTimeout(timer);
  }
}

/** Avisa a la tienda de un pedido recién creado. NUNCA lanza. */
export async function notifyStoreNewOrderSafely(
  orderId: string,
): Promise<StoreWhatsAppStatus> {
  const token = readEnv('WHATSAPP_ACCESS_TOKEN');
  const phoneNumberId = readEnv('WHATSAPP_PHONE_NUMBER_ID');
  if (!token || !phoneNumberId) return 'not_configured';

  try {
    const sql = requirePlatformSql();
    const rows = await sql`
      SELECT s.id AS store_id, s.contact_phone,
             o.order_number, o.total, o.currency, o.item_count, o.metadata
        FROM orders o
        JOIN stores s ON s.id = o.store_id
       WHERE o.id = ${orderId}::uuid
       LIMIT 1
    `;

    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return 'order_not_found';

    const to = normalizeWhatsAppPhone(row.contact_phone as string | null);
    if (!to) return 'no_phone';

    const currency = String(row.currency ?? 'PEN');
    const total = new Intl.NumberFormat('es-PE', {
      style: 'currency',
      currency,
    }).format(Number(row.total));

    const metadata =
      row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {};
    const cash = metadata.paymentMethod === 'cash';

    const message = [
      `Nuevo pedido ${String(row.order_number)}`,
      `Total: ${total} · ${Number(row.item_count)} artículo(s)`,
      cash
        ? 'Pago: EFECTIVO al retirar. Confirma si aceptas este método antes de prepararlo.'
        : 'Pago: Yape/Plin con captura. Revísala y confirma el pago.',
      `Revísalo en tu panel: ${appBaseUrl()}/negocio/${String(row.store_id)}/pedidos/${orderId}`,
    ].join('\n');

    return await sendText(to, message, orderId);
  } catch (error) {
    console.error('[whatsapp] no se pudo avisar a la tienda', {
      orderId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return 'failed';
  }
}

/** Avisa a la tienda que el cliente subió la captura del pago. NUNCA lanza. */
export async function notifyStorePaymentProofSafely(
  orderId: string,
): Promise<StoreWhatsAppStatus> {
  const token = readEnv('WHATSAPP_ACCESS_TOKEN');
  const phoneNumberId = readEnv('WHATSAPP_PHONE_NUMBER_ID');
  if (!token || !phoneNumberId) return 'not_configured';

  try {
    const sql = requirePlatformSql();
    const rows = await sql`
      SELECT s.id AS store_id, s.contact_phone,
             o.order_number, o.total, o.currency, o.metadata
        FROM orders o
        JOIN stores s ON s.id = o.store_id
       WHERE o.id = ${orderId}::uuid
       LIMIT 1
    `;

    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return 'order_not_found';

    const to = normalizeWhatsAppPhone(row.contact_phone as string | null);
    if (!to) return 'no_phone';

    const metadata =
      row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {};
    const buyer = metadata.buyer;
    const buyerName =
      buyer && typeof buyer === 'object' && !Array.isArray(buyer) &&
      typeof (buyer as Record<string, unknown>).fullName === 'string'
        ? String((buyer as Record<string, unknown>).fullName).trim()
        : '';

    const total = new Intl.NumberFormat('es-PE', {
      style: 'currency',
      currency: String(row.currency ?? 'PEN'),
    }).format(Number(row.total));

    const message = [
      `Comprobante recibido · pedido ${String(row.order_number)}`,
      `${buyerName || 'Tu cliente'} subió la captura del pago (${total}).`,
      'Revísala y confirma el pago para preparar el pedido.',
      `${appBaseUrl()}/negocio/${String(row.store_id)}/pedidos/${orderId}`,
    ].join('\n');

    return await sendText(to, message, orderId);
  } catch (error) {
    console.error('[whatsapp] no se pudo avisar del comprobante', {
      orderId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return 'failed';
  }
}
