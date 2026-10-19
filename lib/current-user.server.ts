/**
 * lib/current-user.server.ts — usuario de la request actual en Server Components.
 *
 * `headers()` es asíncrono en Next 16. Better Auth lee la cookie de sesión desde
 * esos headers; no hace falta un endpoint extra ni un provider en el cliente.
 */

import { headers } from 'next/headers';
import { getSessionUser, type SessionUser } from './auth.server';

export async function getCurrentUser(): Promise<SessionUser | null> {
  return getSessionUser(await headers());
}
