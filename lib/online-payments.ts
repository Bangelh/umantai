/**
 * lib/online-payments.ts — ¿se le ofrece pago online al comprador?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  MERCADO PAGO ESTÁ CONGELADO
 *
 *  Por decisión del negocio el cobro online está deshabilitado. Mientras dure
 *  ese estado:
 *
 *    · /pedido/<token> NO muestra el botón de pago y explica que el pago
 *      online no está disponible por ahora;
 *    · /api/payments/preference responde 503 (código
 *      `online_payments_unavailable`) ANTES de llamar a Mercado Pago;
 *    · el resto del flujo no cambia: el pedido se crea, la reserva de stock
 *      vence como siempre y el retiro en locker sigue funcionando.
 *
 *  El interruptor es UNA variable de entorno:
 *
 *      ONLINE_PAYMENTS_ENABLED=1   → se vuelve a ofrecer el pago online
 *      (ausente / 0 / cualquier otro valor) → congelado
 *
 *  El default es "congelado": publicar sin configurar nada nunca empieza a
 *  cobrar por accidente. Reabrir el cobro es un cambio de entorno, no de código.
 *
 *  Este módulo NO contiene lógica de Mercado Pago ni secretos: solo lee el flag.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const ONLINE_PAYMENTS_ENABLED_ENV = 'ONLINE_PAYMENTS_ENABLED';

/**
 * `true` solo con un `1` (o `true`) explícito. Se acepta un mapa de entorno para
 * poder probarlo sin ensuciar `process.env`.
 */
export function isOnlinePaymentEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = (env[ONLINE_PAYMENTS_ENABLED_ENV] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true';
}
