import { NextRequest, NextResponse } from 'next/server';
import { getPrefixedEnv, isVercelPreview } from '@/lib/env';
import { requireAdminToken, type AdminAccessCheck } from '@/lib/admin.server';
import { evaluateOrderPayability } from '@/lib/commerce';
import {
  expireStaleOrders,
  getOrderByPublicToken,
  isCommerceDbConfigured,
  saveOrderPaymentPreference,
} from '@/lib/commerce.server';
import {
  createCheckoutPreference,
  isMercadoPagoConfigured,
  isStoredPreferenceFresh,
  matchesNotificationRouting,
  readStoredCheckoutPreference,
  toStoredPreferenceSnapshot,
} from '@/lib/mercadopago.server';

/**
 * POST /api/payments/preference — crea el checkout de Mercado Pago de un pedido.
 *
 * Body: { token: string }   ← `orders.public_token`, el mismo de /pedido/<token>
 * Responde: { initPoint, preferenceId, sandboxInitPoint, reused }
 *
 * ─── POR QUÉ SOLO VIAJA EL TOKEN ─────────────────────────────────────────────
 * El navegador NO manda el monto. Si aceptáramos `{ total, items }` desde el
 * cliente, cualquiera podría pedir un link de pago por S/ 1.00 y luego reclamar el
 * pedido completo: el comprador controla su propio precio. Todo lo que se cobra se
 * lee del pedido ya persistido en Postgres.
 *
 * ─── ESTADOS ─────────────────────────────────────────────────────────────────
 * 201 creada · 200 reutilizada · 400 token inválido · 404 pedido inexistente
 * 409 pedido no pagable (ya confirmado/cancelado, o reserva vencida) · 502 MP caído
 * 503 sin base de datos o sin MERCADOPAGO_ACCESS_TOKEN
 */

/**
 * Header que pide el modo diagnóstico de enrutamiento de notificaciones.
 *
 * Es un opt-in EXPLÍCITO: si no viaja (que es lo normal), el flujo sigue enviando
 * `notification_url` como siempre. Activarlo exige además Preview + token admin
 * (ver `decideNotificationRouting`).
 */
export const MP_DIAGNOSTIC_HEADER = 'x-mp-diagnostic';

/** Valor exacto que activa el modo (omitir `notification_url` para usar el dashboard). */
export const MP_DIAGNOSTIC_OMIT_NOTIFICATION_URL = 'omit-notification-url';

/** ¿La petición pide explícitamente crear una Preference SIN `notification_url`? */
export function requestedNotificationUrlOmission(request: Request): boolean {
  const raw = (request.headers.get(MP_DIAGNOSTIC_HEADER) ?? '').trim().toLowerCase();
  return raw === MP_DIAGNOSTIC_OMIT_NOTIFICATION_URL;
}

export type NotificationRoutingDecision =
  | { ok: true; omitNotificationUrl: boolean }
  | { ok: false; status: number; code: string; message: string };

/**
 * Decide si la petición puede crear una Preference de diagnóstico sin
 * `notification_url`.
 *
 * Candados (TODOS obligatorios para activar el modo):
 *   1. La petición debe pedirlo explícitamente (header `x-mp-diagnostic`).
 *   2. `VERCEL_ENV === 'preview'`: Production NUNCA puede activarlo.
 *   3. Token admin válido (`x-admin-token`).
 *
 * Sin la petición explícita devuelve `omitNotificationUrl: false` sin exigir nada
 * más, así que el flujo público normal queda intacto.
 */
export function decideNotificationRouting(
  diagnosticRequested: boolean,
  isPreview: boolean,
  admin: AdminAccessCheck,
): NotificationRoutingDecision {
  if (!diagnosticRequested) return { ok: true, omitNotificationUrl: false };

  if (!isPreview) {
    return {
      ok: false,
      status: 403,
      code: 'diagnostic_not_available',
      message: 'El diagnóstico de notification_url solo está disponible en Preview.',
    };
  }

  if (!admin.ok) {
    return { ok: false, status: admin.status, code: admin.code, message: admin.message };
  }

  return { ok: true, omitNotificationUrl: true };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PreferenceRequestBody {
  token?: unknown;
}

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * Base absoluta para `back_urls` y `notification_url`.
 *
 * Se prefieren las cabeceras del proxy (Cloudflare/Vercel) porque `nextUrl.origin`
 * se queda con el host interno cuando la app corre detrás de un proxy. Si nada de
 * eso sirve, se puede forzar con `MERCADOPAGO_BACK_URL_BASE`.
 */
function resolveOrigin(request: NextRequest): string {
  const configured = (getPrefixedEnv('MERCADOPAGO_BACK_URL_BASE') ?? '').trim();
  if (configured) return configured.replace(/\/+$/, '');

  const forwardedHost = request.headers.get('x-forwarded-host');
  if (forwardedHost) {
    const proto = request.headers.get('x-forwarded-proto') ?? 'https';
    return `${proto}://${forwardedHost}`;
  }

  return request.nextUrl.origin;
}

export async function POST(request: NextRequest) {
  if (!isCommerceDbConfigured()) {
    return NextResponse.json(
      { error: 'Database not configured. Run `vercel env pull .env.local` and apply db/migrations/001_commerce_core.sql.' },
      { status: 503 },
    );
  }

  if (!isMercadoPagoConfigured()) {
    return NextResponse.json(
      {
        error:
          'Mercado Pago is not configured. Set MERCADOPAGO_ACCESS_TOKEN in your environment (test credentials while developing).',
        code: 'mercadopago_not_configured',
      },
      { status: 503 },
    );
  }

  // Modo diagnóstico de enrutamiento de notificaciones (deshabilitado por defecto).
  // Pasa por aquí ANTES de tocar la base de datos: si no está autorizado, no se lee nada.
  const diagnosticRequested = requestedNotificationUrlOmission(request);
  const isPreview = isVercelPreview();
  const admin: AdminAccessCheck =
    diagnosticRequested && isPreview ? requireAdminToken(request) : { ok: true };
  const routing = decideNotificationRouting(diagnosticRequested, isPreview, admin);
  if (!routing.ok) {
    return NextResponse.json({ error: routing.message, code: routing.code }, { status: routing.status });
  }
  const { omitNotificationUrl } = routing;

  let body: PreferenceRequestBody;
  try {
    body = (await request.json()) as PreferenceRequestBody;
  } catch {
    return badRequest('Invalid JSON body');
  }

  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!token) return badRequest('token is required');
  // Validación barata: evita mandar basura a Postgres con un cast ::uuid.
  if (!UUID_PATTERN.test(token)) return badRequest('token must be a valid UUID');

  let order;
  try {
    order = await getOrderByPublicToken(token);
  } catch (error) {
    console.error('POST /api/payments/preference: no se pudo leer el pedido', error);
    return NextResponse.json({ error: 'Failed to load the order' }, { status: 500 });
  }

  if (!order) {
    return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  }

  // La MISMA regla que usa la página de estado para mostrar (o esconder) el botón de
  // pago, definida una sola vez en `lib/commerce.ts`.
  const payability = evaluateOrderPayability(order);

  if (payability === 'order_not_payable') {
    // Pagar dos veces un pedido ya confirmado (o cancelado) crearía un cobro huérfano.
    return NextResponse.json(
      {
        error: `This order is not awaiting payment (current status: ${order.status}).`,
        code: 'order_not_payable',
      },
      { status: 409 },
    );
  }

  if (payability === 'reservation_expired') {
    // El pedido sigue en `pending_payment` pero su reserva ya venció: no se cobra
    // (el stock pudo venderse a otra persona).
    //
    // Antes de responder "expirado", se suelta el stock DE VERDAD: con el cron diario
    // de Vercel Hobby, el reaper puede tardar hasta un día en pasar y el stock quedaría
    // retenido sin dueño. Se reutiliza el MISMO motor del cron (`expire_stale_orders`),
    // nunca una liberación paralela, y sólo libera reservas realmente vencidas (reloj de
    // Postgres): jamás suelta una reserva válida antes de tiempo.
    //
    // Si el barrido falla, la respuesta es la misma: este endpoint no cobra, y un fallo
    // de mantenimiento no debe cambiarle el mensaje al comprador.
    try {
      const expired = await expireStaleOrders();
      if (expired > 0) {
        console.info(`[preference] reservas vencidas liberadas: ${expired}`);
      }
    } catch (error) {
      console.error('POST /api/payments/preference: el barrido de reservas vencidas falló', error);
    }

    return NextResponse.json(
      {
        error:
          'The stock reservation for this order expired. Start the checkout again to reserve the items.',
        code: 'reservation_expired',
      },
      { status: 409 },
    );
  }

  // Doble clic / reintento de red: devolvemos la Preference que ya generamos.
  // Solo si pertenece al MISMO modo: no se reutiliza una Preference de diagnóstico
  // (sin `notification_url`) en el flujo normal, ni al revés.
  const stored = readStoredCheckoutPreference(order);
  if (stored && isStoredPreferenceFresh(stored) && matchesNotificationRouting(stored, omitNotificationUrl)) {
    return NextResponse.json(
      {
        initPoint: stored.initPoint,
        sandboxInitPoint: stored.sandboxInitPoint,
        preferenceId: stored.preferenceId,
        orderNumber: order.orderNumber,
        notificationSource: stored.notificationSource ?? 'preference',
        reused: true,
      },
      { status: 200 },
    );
  }

  try {
    const preference = await createCheckoutPreference(order, {
      origin: resolveOrigin(request),
      // Una Preference por pedido: mismo pedido = misma clave = una sola Preference.
      idempotencyKey: `preference-${order.id}`,
      omitNotificationUrl,
    });

    // Best-effort: si falla el guardado, el comprador igual debe poder pagar.
    try {
      // El snapshot incluye la `notificationUrl` REAL enviada a MP (`toStoredPreferenceSnapshot`),
      // para poder auditar a dónde notifica MP sin recalcular nada después.
      await saveOrderPaymentPreference(order.id, toStoredPreferenceSnapshot(preference));
    } catch (error) {
      console.error('POST /api/payments/preference: no se pudo guardar la Preference', error);
    }

    return NextResponse.json(
      {
        initPoint: preference.initPoint,
        sandboxInitPoint: preference.sandboxInitPoint,
        preferenceId: preference.preferenceId,
        orderNumber: order.orderNumber,
        notificationSource: preference.notificationSource ?? 'preference',
        reused: false,
      },
      { status: 201 },
    );
  } catch (error) {
    console.error('POST /api/payments/preference: Mercado Pago rechazó la Preference', error);

    return NextResponse.json(
      {
        error: 'Mercado Pago could not create the payment link. Please try again in a moment.',
        code: 'mercadopago_error',
        // El detalle del API de MP solo se filtra fuera de producción: acelera el
        // diagnóstico local y no expone nada al comprador en el sitio real.
        ...(process.env.NODE_ENV !== 'production'
          ? { detail: error instanceof Error ? error.message : String(error) }
          : {}),
      },
      { status: 502 },
    );
  }
}
