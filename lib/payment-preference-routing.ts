/**
 * lib/payment-preference-routing.ts — helpers PUROS del modo diagnóstico de
 * `notification_url` de Checkout Pro.
 *
 * Vivían en `app/api/payments/preference/route.ts`. Next 16 rechaza en el build
 * cualquier export que no sea un handler válido de route, así que se movieron acá
 * SIN cambios de comportamiento. La ruta los importa y los tests los prueban
 * directamente.
 *
 * Mercado Pago (Checkout Pro y Orders) no se modifica: esto sólo decide si una
 * petición pide el modo diagnóstico y si tiene permiso para usarlo.
 */

import type { AdminAccessCheck } from './admin.server';

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
