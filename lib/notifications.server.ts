/**
 * lib/notifications.server.ts — avisos internos de la tienda (solo servidor).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  FASE 1 DE NOTIFICACIÓN: CORREO AL ADMINISTRADOR
 *
 *  El flujo de retiro es híbrido: el CLIENTE es el único que ve su PIN (en
 *  /pedido/<token>, para dictárselo a la operaria) y el ADMINISTRADOR recibe un
 *  aviso cuando hay mercadería esperando. Ese aviso es este módulo.
 *
 *  Hoy el canal es correo (Resend) porque es lo que se puede montar sin papeleo
 *  del negocio. La versión comercial escala a WhatsApp; por eso la API pública
 *  (`notifyPickupReadySafely`) NO menciona el canal: agregar WhatsApp será un
 *  `sendWhatsApp()` adentro, sin tocar la ruta del kiosco.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  REGLA DE ORO: AVISAR NUNCA ROMPE LA ENTREGA
 *
 *  Cuando se llama a `notifyPickupReadySafely()` el PIN YA existe y el pedido YA
 *  está listo. Un correo que falla no puede revertir eso: el cliente está en el
 *  mostrador y la operaria tiene que poder entregarle igual.
 *
 *  Por eso estos métodos NO lanzan excepciones por fallos de envío: devuelven un
 *  resultado (`sent` / `failed` / `not_configured`) que la ruta traduce a un aviso
 *  en pantalla. La diferencia entre "no se pudo avisar a Omar" y "no se pudo
 *  preparar el pedido" es exactamente la que no se puede perder.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  Variables de entorno (aceptan los prefijos de Vercel `BANGELH_` / `UMANTAI_URL_`
 *  vía `getPrefixedEnv`):
 *
 *   RESEND_API_KEY            (requerida)  API key de Resend. Sin ella no se envía nada.
 *   ADMIN_NOTIFICATION_EMAIL  (requerida)  Destinatario(s) del aviso. Varios: separados
 *                                          por coma. Ej. `omar@umantai.com,caja@umantai.com`.
 *   RESEND_FROM_EMAIL         Remitente. Por defecto `onboarding@resend.dev`, que
 *                             SOLO entrega al correo dueño de la cuenta de Resend
 *                             (suficiente para el MVP; requiere dominio verificado
 *                             para escribir a cualquier dirección).
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
 * `onboarding@resend.dev` es la dirección de pruebas de Resend: entrega únicamente
 * al correo dueño de la cuenta. Para escribir a Omar en su dirección real hay que
 * verificar el dominio y definir `RESEND_FROM_EMAIL`.
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

/** Se avisa una sola vez por proceso: si `ADMIN_NOTIFICATION_EMAIL` está mal escrito,
 *  todos los pedidos quedarían sin aviso y sin ninguna señal en los logs. */
function warnOnceAboutBadRecipients(raw: string): void {
  if (warnedAboutBadRecipients || !raw) return;
  warnedAboutBadRecipients = true;
  console.warn(
    '⚠️  ADMIN_NOTIFICATION_EMAIL no contiene ninguna dirección válida. ' +
      'Omar no va a recibir avisos de retiro.',
  );
}

/** Destinatarios válidos del aviso interno (soporta varios separados por coma). */
export function getAdminNotificationRecipients(): string[] {
  const raw = readEnv('ADMIN_NOTIFICATION_EMAIL');
  const recipients = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => EMAIL_PATTERN.test(value));

  if (recipients.length === 0) warnOnceAboutBadRecipients(raw);
  return recipients;
}

/** ¿Se puede avisar por correo? Si no, la ruta lo reporta en vez de fallar. */
export function isAdminNotificationConfigured(): boolean {
  return getResendApiKey().length > 0 && getAdminNotificationRecipients().length > 0;
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
 * Resultado de intentar avisar a la tienda.
 *
 * `failed` y `not_configured` NO son errores del pedido: el PIN se emitió igual.
 * La ruta del kiosco los usa para decirle a la operaria si Omar quedó enterado.
 */
export type AdminNotificationStatus = 'sent' | 'failed' | 'not_configured' | 'order_not_found';

export interface AdminNotificationResult {
  status: AdminNotificationStatus;
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
 * Cuerpo del aviso: lo que el administrador necesita para atender el mostrador.
 *
 * Los tres datos que el negocio pidió —número de pedido, total y PIN— van arriba y
 * en grande; el PIN también viaja en el asunto para que se lea desde la notificación
 * del teléfono sin abrir el correo. El detalle se deja en texto plano y sin imágenes
 * a propósito: esto se lee en un celular, apurado, con el cliente delante.
 */
function buildPickupReadyEmail(order: OrderWithItems, pickupCode: PickupCode): PickupReadyEmail {
  const pin = spaceDigits(pickupCode.code);
  const total = formatMoney(order.total, order.currency);
  const placedAt = formatDateTime(pickupCode.createdAt);
  const expiresAt = formatDateTime(pickupCode.expiresAt);
  const buyerName = readBuyerName(order);
  const location = pickupCode.lockerSlot
    ? `Casillero ${pickupCode.lockerSlot}`
    : pickupCode.lockerCode ?? 'Mostrador';

  const rows: Array<[string, string]> = [
    ['Pedido', order.orderNumber],
    ['Total', total],
    ['Ubicación', location],
    ['Cliente', buyerName ? `${buyerName} · ${order.contactEmail}` : order.contactEmail],
  ];

  if (expiresAt) rows.push(['El PIN vence', expiresAt]);

  const rowsHtml = rows
    .map(
      ([label, value]) => `
        <tr>
          <td style="padding:6px 16px 6px 0;font-size:16px;color:#555555;white-space:nowrap;">${escapeHtml(label)}</td>
          <td style="padding:6px 0;font-size:16px;color:#111111;font-weight:600;">${escapeHtml(value)}</td>
        </tr>`,
    )
    .join('');

  const html = `<!DOCTYPE html>
<html lang="es">
  <body style="margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px;">
      <p style="margin:0;font-size:14px;letter-spacing:2px;color:#666666;">PEDIDO LISTO PARA ENTREGAR</p>
      <h1 style="margin:8px 0 24px;font-size:28px;color:#111111;">${escapeHtml(order.orderNumber)}</h1>

      <div style="border:3px solid #059669;border-radius:14px;padding:20px;text-align:center;">
        <p style="margin:0 0 8px;font-size:15px;letter-spacing:1px;color:#047857;">PIN DE RETIRO</p>
        <p style="margin:0;font-size:44px;line-height:1.2;font-weight:700;letter-spacing:6px;color:#065f46;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;">${escapeHtml(pin)}</p>
      </div>

      <p style="margin:16px 0 24px;font-size:15px;color:#444444;">
        El cliente dicta este PIN en el kiosco. La operaria lo tipea para entregar el pedido
        y descontar el inventario.
      </p>

      <table style="border-collapse:collapse;width:100%;">
        ${rowsHtml}
      </table>

      <p style="margin:24px 0 0;font-size:13px;color:#888888;border-top:1px solid #e4e4e7;padding-top:16px;">
        Aviso automático del kiosco${placedAt ? ` · emitido el ${escapeHtml(placedAt)}` : ''}.
        El PIN es de un solo uso y sólo sirve para este pedido.
      </p>
    </div>
  </body>
</html>`;

  const text = [
    `PEDIDO LISTO PARA ENTREGAR — ${order.orderNumber}`,
    '',
    `PIN DE RETIRO: ${pickupCode.code}`,
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    '',
    'El cliente dicta este PIN en el kiosco. El PIN es de un solo uso y sólo sirve para este pedido.',
  ].join('\n');

  return {
    // El PIN va en el asunto a propósito: se lee desde la notificación del celular
    // sin abrir nada, con el cliente esperando en el mostrador.
    subject: `Pedido ${order.orderNumber} listo · PIN ${pickupCode.code}`,
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
 * Avisa al administrador que un pedido quedó listo para entregar.
 *
 * NUNCA lanza: cualquier fallo —falta de configuración, pedido inexistente, API de
 * Resend caída— se devuelve como `status` para que el kiosco pueda avisar sin
 * bloquear la entrega.
 */
export async function notifyPickupReadySafely(
  orderId: string,
  pickupCode: PickupCode,
): Promise<AdminNotificationResult> {
  try {
    if (!isAdminNotificationConfigured()) return { status: 'not_configured' };

    const order = await getOrderWithItems(orderId);
    if (!order) {
      console.error('[notificaciones] el pedido no existe', { orderId });
      return { status: 'order_not_found' };
    }

    const email = buildPickupReadyEmail(order, pickupCode);

    const { data, error } = await withTimeout(
      getResendClient().emails.send(
        {
          from: getNotificationSender(),
          to: getAdminNotificationRecipients(),
          subject: email.subject,
          html: email.html,
          text: email.text,
          tags: [{ name: 'evento', value: 'pedido_listo' }],
        },
        // Clave estable por pedido: un reintento de la pantalla (o un doble toque)
        // reusa el mismo aviso en vez de llenarle la bandeja a Omar.
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
    console.error('[notificaciones] no se pudo enviar el aviso a la tienda', { orderId, reason });
    return { status: 'failed', reason };
  }
}
