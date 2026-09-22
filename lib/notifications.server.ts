/**
 * lib/notifications.server.ts — avisos de retiro al comprador (solo servidor).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  FASE 1 DE NOTIFICACIÓN: CORREO AL CLIENTE
 *
 *  El software se vende como servicio (SaaS) a la dueña de la tienda, así que el
 *  aviso va al COMPRADOR y no a la tienda: quien espera la mercadería es él. El
 *  destinatario sale del propio pedido (`orders.contact_email`), nunca del entorno:
 *  cada tienda y cada pedido traen su cliente.
 *
 *  El cliente ya puede ver su PIN en /pedido/<token>; este correo es el empujón para
 *  que se entere de que puede acercarse. La tienda se entera por el kiosco, no por
 *  correo.
 *
 *  Hoy el canal es correo (Resend). La versión comercial escala a WhatsApp; por eso la
 *  API pública (`notifyPickupReadySafely`) NO menciona el canal: agregar WhatsApp será
 *  un `sendWhatsApp()` adentro, sin tocar la ruta del kiosco.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  REGLA DE ORO: AVISAR NUNCA ROMPE LA ENTREGA
 *
 *  Cuando se llama a `notifyPickupReadySafely()` el PIN YA existe y el pedido YA
 *  está listo. Un correo que falla no puede revertir eso: el cliente está en el
 *  mostrador y la operaria tiene que poder entregarle igual.
 *
 *  Por eso estos métodos NO lanzan excepciones por fallos de envío: devuelven un
 *  resultado (`sent` / `failed` / `not_configured` / `invalid_recipient`) que la ruta
 *  traduce a un aviso en pantalla. La diferencia entre "no se pudo avisar al cliente"
 *  y "no se pudo preparar el pedido" es exactamente la que no se puede perder.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  Variables de entorno (aceptan los prefijos de Vercel `BANGELH_` / `UMANTAI_URL_`
 *  vía `getPrefixedEnv`):
 *
 *   RESEND_API_KEY     (requerida)  API key de Resend. Sin ella no se envía nada.
 *   RESEND_FROM_EMAIL  Remitente. Por defecto `onboarding@resend.dev`, que SOLO
 *                      entrega al correo dueño de la cuenta de Resend — o sea, con el
 *                      default los avisos al comprador NO llegan. Hay que verificar el
 *                      dominio de la tienda antes de vender esto.
 *
 *  `ADMIN_NOTIFICATION_EMAIL` ya no se usa: el destinatario es el comprador.
 */

import { Resend } from 'resend';
import { getPrefixedEnv } from './env';
import { getOrderWithItems } from './commerce.server';
import type { OrderWithItems, PickupCode } from './commerce';

/**
 * Tope de espera del envío.
 *
 * La tablet del kiosco queda con la operaria esperando frente al cliente: si la API
 * de Resend no contesta, el pedido ya está listo y no hay razón para tenerla mirando
 * una pantalla trabada. El SDK no expone un `timeout`, así que se corta por fuera.
 */
const SEND_TIMEOUT_MS = 5_000;

/**
 * Remitente por defecto cuando no hay dominio verificado.
 *
 * ⚠️  `onboarding@resend.dev` es la dirección de PRUEBAS de Resend y entrega
 * únicamente al correo dueño de la cuenta. El destinatario ahora es el COMPRADOR, así
 * que con el remitente por defecto el aviso no le llega a nadie: hay que verificar el
 * dominio de la tienda en Resend y definir `RESEND_FROM_EMAIL` (ej.
 * `Umantai <pedidos@umantai.com>`) antes de vender esto. Mientras tanto el flujo no se
 * rompe —el aviso queda en `failed` y el kiosco lo advierte—, pero el cliente no recibe
 * nada y sólo se entera por su propia pantalla de pedido.
 */
const DEFAULT_SENDER = 'Umantai <onboarding@resend.dev>';

/** Validación deliberadamente laxa: la API de Resend es la que decide de verdad. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// =============================================================================
//  1. CONFIGURACIÓN
// =============================================================================

function readEnv(key: string): string {
  return (getPrefixedEnv(key) ?? '').trim();
}

export function getResendApiKey(): string {
  return readEnv('RESEND_API_KEY');
}

export function getNotificationSender(): string {
  return readEnv('RESEND_FROM_EMAIL') || DEFAULT_SENDER;
}

let warnedAboutBadRecipients = false;

/** Se avisa una sola vez por proceso: si un pedido trae un correo de contacto mal
 *  escrito, el aviso se pierde en silencio y no quedaría ninguna señal en los logs. */
function warnOnceAboutBadRecipients(raw: string): void {
  if (warnedAboutBadRecipients || !raw) return;
  warnedAboutBadRecipients = true;
  console.warn(
    '⚠️  El pedido trae un correo de contacto inválido: el cliente no va a ' +
      'recibir el aviso de retiro.',
  );
}

/**
 * Destinatario del aviso: el CORREO DEL COMPRADOR (`orders.contact_email`).
 *
 * En un SaaS el aviso va al cliente final y no a la tienda: quien espera la mercadería
 * es él, y la dueña no tiene por qué ver la bandeja de sus clientes. Devuelve `null`
 * cuando el correo del checkout no es usable — un dato mal tecleado no puede convertirse
 * en un envío a cualquier cosa.
 */
export function getCustomerRecipient(order: OrderWithItems): string | null {
  const raw = (order.contactEmail ?? '').trim();
  if (EMAIL_PATTERN.test(raw)) return raw;

  warnOnceAboutBadRecipients(raw);
  return null;
}

/** ¿Se puede avisar por correo? Si no, la ruta lo reporta en vez de fallar. */
export function isCustomerNotificationConfigured(): boolean {
  return getResendApiKey().length > 0;
}

/**
 * Cliente de Resend cacheado por instancia, igual que el de Mercado Pago: se recrea
 * si cambia la API key (rotarla sin reiniciar el proceso no debería dejarnos
 * mandando correos con credenciales viejas).
 */
let cachedClient: Resend | null = null;
let cachedKey: string | null = null;

function getResendClient(): Resend {
  const apiKey = getResendApiKey();
  if (!apiKey) throw new Error('resend_not_configured');

  if (!cachedClient || cachedKey !== apiKey) {
    cachedClient = new Resend(apiKey);
    cachedKey = apiKey;
  }

  return cachedClient;
}

// =============================================================================
//  2. TIPOS
// =============================================================================

/**
 * Resultado de intentar avisar al cliente.
 *
 * `failed`, `invalid_recipient` y `not_configured` NO son errores del pedido: el PIN se
 * emitió igual. La ruta del kiosco los usa para decirle a la operaria si el cliente
 * quedó avisado — el PIN se dicta en el mostrador de todas formas.
 */
export type CustomerNotificationStatus =
  | 'sent'
  | 'failed'
  | 'not_configured'
  | 'order_not_found'
  | 'invalid_recipient';

export interface CustomerNotificationResult {
  status: CustomerNotificationStatus;
  /** Id del correo en Resend (solo cuando `status === 'sent'`). */
  messageId?: string;
  /** Motivo legible para los logs (solo cuando `status === 'failed'`). */
  reason?: string;
}

// =============================================================================
//  3. HELPERS DE FORMATO
// =============================================================================

/**
 * Escapa texto que viene del comprador antes de meterlo en el HTML del correo.
 *
 * El nombre y el teléfono los teclea quien compra: sin escapar, un `<` en el
 * formulario de checkout se convierte en marcado arbitrario dentro de la bandeja
 * del administrador.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('es-PE', { style: 'currency', currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

function formatDateTime(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return new Intl.DateTimeFormat('es-PE', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Lima',
  }).format(date);
}

/** `123456` → `1 2 3 4 5 6`: el espaciado es lo que hace legible un PIN de un vistazo. */
function spaceDigits(code: string): string {
  return code.split('').join(' ');
}

/** Tope defensivo: un solo aviso no debería poder colgar la ruta del kiosco. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('resend_request_timeout')), ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// =============================================================================
//  4. CONTENIDO DEL CORREO
// =============================================================================

interface PickupReadyEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Cuerpo del aviso al COMPRADOR: qué hacer y con qué PIN.
 *
 * Acá no hay nada que a la operaria le sirva: el cliente sólo tiene que enterarse de
 * que puede acercarse y cuál es su PIN. Por eso el PIN va primero y en grande, y el
 * detalle (pedido, total, vencimiento) queda abajo. El texto es plano y sin imágenes a
 * propósito: llega bien a cualquier cliente de correo y se lee en el celular, de pie en
 * la tienda.
 */
function buildPickupReadyEmail(order: OrderWithItems, pickupCode: PickupCode): PickupReadyEmail {
  const pin = spaceDigits(pickupCode.code);
  const total = formatMoney(order.total, order.currency);
  const expiresAt = formatDateTime(pickupCode.expiresAt);
  const buyerName = readBuyerName(order);

  const rows: Array<[string, string]> = [
    ['Pedido', order.orderNumber],
    ['Total', total],
  ];

  if (expiresAt) rows.push(['Tu PIN vence', expiresAt]);
  if (order.pickupInstructions) rows.push(['Indicaciones', order.pickupInstructions]);

  const rowsHtml = rows
    .map(
      ([label, value]) => `
        <tr>
          <td style="padding:6px 16px 6px 0;font-size:16px;color:#555555;white-space:nowrap;">${escapeHtml(label)}</td>
          <td style="padding:6px 0;font-size:16px;color:#111111;font-weight:600;">${escapeHtml(value)}</td>
        </tr>`,
    )
    .join('');

  const greeting = buyerName ? `¡Hola, ${escapeHtml(buyerName)}!` : '¡Hola!';

  const html = `<!DOCTYPE html>
<html lang="es">
  <body style="margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px;">
      <p style="margin:0;font-size:14px;letter-spacing:2px;color:#666666;">UMANTAI</p>
      <h1 style="margin:8px 0 12px;font-size:26px;color:#111111;">¡Tu pedido está listo para retirar!</h1>

      <p style="margin:0 0 24px;font-size:16px;color:#444444;">
        ${greeting} Acércate al mostrador y dicta este PIN de 6 dígitos para que te
        entreguen tus productos.
      </p>

      <div style="border:3px solid #059669;border-radius:14px;padding:20px;text-align:center;">
        <p style="margin:0 0 8px;font-size:15px;letter-spacing:1px;color:#047857;">TU PIN DE RETIRO</p>
        <p style="margin:0;font-size:44px;line-height:1.2;font-weight:700;letter-spacing:6px;color:#065f46;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;">${escapeHtml(pin)}</p>
      </div>

      <p style="margin:16px 0 24px;font-size:15px;color:#444444;">
        Muéstraselo a la persona que te atienda: lo va a ingresar para entregarte el pedido.
        El PIN es personal, de un solo uso y sólo sirve para este pedido.
      </p>

      <table style="border-collapse:collapse;width:100%;">
        ${rowsHtml}
      </table>

      <p style="margin:24px 0 0;font-size:13px;color:#888888;border-top:1px solid #e4e4e7;padding-top:16px;">
        Si ya retiraste tus productos o no hiciste este pedido, puedes ignorar este correo.
      </p>
    </div>
  </body>
</html>`;

  const text = [
    `¡Tu pedido ${order.orderNumber} está listo para retirar!`,
    '',
    `TU PIN DE RETIRO: ${pickupCode.code}`,
    '',
    'Acércate al mostrador y dicta este PIN de 6 dígitos para que te entreguen tus productos.',
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    '',
    'El PIN es personal, de un solo uso y sólo sirve para este pedido.',
  ].join('\n');

  return {
    // El PIN va en el asunto a propósito: se lee desde la notificación del celular
    // sin abrir nada, de pie frente al mostrador.
    subject: `¡Tu pedido ${order.orderNumber} está listo! · PIN ${pickupCode.code}`,
    html,
    text,
  };
}

/** Nombre del comprador del checkout (`orders.metadata.buyer.fullName`), si existe. */
function readBuyerName(order: OrderWithItems): string | null {
  const buyer = order.metadata?.buyer;
  if (!buyer || typeof buyer !== 'object' || Array.isArray(buyer)) return null;

  const fullName = (buyer as Record<string, unknown>).fullName;
  if (typeof fullName !== 'string') return null;

  const trimmed = fullName.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// =============================================================================
//  5. API PÚBLICA
// =============================================================================

/**
 * Avisa al COMPRADOR que su pedido quedó listo para retirar.
 *
 * NUNCA lanza: cualquier fallo —falta de configuración, pedido inexistente, correo de
 * contacto inválido, API de Resend caída— se devuelve como `status` para que el kiosco
 * pueda avisar sin bloquear la entrega.
 */
export async function notifyPickupReadySafely(
  orderId: string,
  pickupCode: PickupCode,
): Promise<CustomerNotificationResult> {
  try {
    if (!isCustomerNotificationConfigured()) return { status: 'not_configured' };

    const order = await getOrderWithItems(orderId);
    if (!order) {
      console.error('[notificaciones] el pedido no existe', { orderId });
      return { status: 'order_not_found' };
    }

    // El destinatario sale del pedido (quien compró), no del entorno (quien administra).
    const recipient = getCustomerRecipient(order);
    if (!recipient) {
      console.error('[notificaciones] el pedido no tiene un correo de contacto válido', { orderId });
      return { status: 'invalid_recipient' };
    }

    const email = buildPickupReadyEmail(order, pickupCode);

    const { data, error } = await withTimeout(
      getResendClient().emails.send(
        {
          from: getNotificationSender(),
          to: [recipient],
          subject: email.subject,
          html: email.html,
          text: email.text,
          tags: [{ name: 'evento', value: 'pedido_listo' }],
        },
        // Clave estable por pedido: un reintento de la pantalla (o un doble toque)
        // reusa el mismo aviso en vez de mandarle tres correos al cliente.
        { idempotencyKey: `pickup-ready-${orderId}` },
      ),
      SEND_TIMEOUT_MS,
    );

    if (error) {
      console.error('[notificaciones] Resend rechazó el aviso', {
        orderId,
        statusCode: error.statusCode,
        message: error.message,
      });
      return { status: 'failed', reason: error.message };
    }

    return { status: 'sent', messageId: data?.id };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error('[notificaciones] no se pudo enviar el aviso al cliente', { orderId, reason });
    return { status: 'failed', reason };
  }
}
