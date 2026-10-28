/**
 * lib/e2e-access.server.ts — puerta única del E2E contra un entorno real.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  QUÉ PROTEGE
 *
 *  El endpoint que devuelve enlaces con token (`/api/auth/test/outbox`) y el
 *  cupo alto de rate limit de autenticación. Ambos son privilegios de una
 *  corrida automatizada, no de un visitante.
 *
 *  REGLAS
 *
 *  · Exige `AUTH_TEST_MODE=1` y un entorno distinto de Producción (lo resuelve
 *    `isAuthTestMode()`), así que no puede abrirse en Producción ni por error.
 *  · Exige `E2E_TEST_TOKEN` configurado (mínimo 16 caracteres) y el header
 *    `x-e2e-token` en la petición, comparados en tiempo constante.
 *  · Sin token, todo se comporta como inexistente (404) y con los límites
 *    normales: no hay diferencia observable entre "no configurado" y
 *    "token incorrecto".
 *
 *  No es una puerta trasera: el token no crea sesiones, no lee datos de
 *  negocio y no permite enviar correo. Solo habilita leer los enlaces de
 *  verificación/recuperación de direcciones `@umantai.test`, que no existen
 *  fuera del entorno de pruebas.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { timingSafeEqual } from 'node:crypto';

import { isAuthTestMode } from './email.server';

export const E2E_TOKEN_HEADER = 'x-e2e-token';

/** Longitud mínima aceptada para el secreto de E2E. */
export const E2E_TOKEN_MIN_LENGTH = 16;

function configuredToken(): string {
  return (process.env.E2E_TEST_TOKEN ?? '').trim();
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** `true` si el entorno puede atender una corrida E2E (flag + secreto). */
export function isE2EConfigured(): boolean {
  return isAuthTestMode() && configuredToken().length >= E2E_TOKEN_MIN_LENGTH;
}

/** Valida un token recibido. Nunca lanza y nunca revela la causa del rechazo. */
export function hasValidE2EToken(value: string | null | undefined): boolean {
  if (!isE2EConfigured() || !value) return false;
  return constantTimeEquals(value.trim(), configuredToken());
}

/** `true` si la petición viene de una corrida E2E autorizada. */
export function isE2ERequest(request: { headers: Headers }): boolean {
  return hasValidE2EToken(request.headers.get(E2E_TOKEN_HEADER));
}
