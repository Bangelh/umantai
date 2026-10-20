'use client';

/**
 * lib/usePlatformAdminSession.ts — estado de la sesión de Platform Admin.
 *
 * La UI humana NUNCA pide ADMIN_API_SECRET. El flujo es:
 *   1. existe cookie firmada `umantai_platform_admin` → autenticado;
 *   2. hay sesión Better Auth de un usuario autorizado → se canjea (POST);
 *   3. no hay cuenta → se manda a /ingresar;
 *   4. la cuenta no es Platform Admin → 403 explicado.
 *
 * El token compartido sigue disponible SOLO para automatización/endpoints
 * internos; no se ofrece como formulario.
 */

import { useCallback, useEffect, useState } from 'react';

export type PlatformAdminStatus =
  | 'checking'
  | 'authenticated'
  | 'anonymous'
  | 'forbidden'
  | 'unavailable';

export interface PlatformAdminSession {
  status: PlatformAdminStatus;
  email: string | null;
  /** Vuelve a consultar el estado (sin canjear). */
  refresh: () => Promise<void>;
  /** Canjea la sesión de Better Auth por la cookie de admin. */
  activate: () => Promise<PlatformAdminStatus>;
  /** Cierra la cookie de admin (mantiene la sesión de usuario). */
  signOut: () => Promise<void>;
}

interface SessionPayload {
  authenticated?: boolean;
  via?: string | null;
  user?: { email?: string | null } | null;
  configured?: boolean;
  error?: string;
}

export function usePlatformAdminSession(): PlatformAdminSession {
  const [status, setStatus] = useState<PlatformAdminStatus>('checking');
  const [email, setEmail] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/admin/session', {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      const payload = (await response.json().catch(() => null)) as SessionPayload | null;
      if (!response.ok) {
        setStatus('unavailable');
        return;
      }
      if (payload?.authenticated) {
        setEmail(payload.user?.email ?? null);
        setStatus('authenticated');
        return;
      }
      setEmail(null);
      setStatus('anonymous');
    } catch {
      setStatus('unavailable');
    }
  }, []);

  const activate = useCallback(async (): Promise<PlatformAdminStatus> => {
    try {
      const response = await fetch('/api/admin/session', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const payload = (await response.json().catch(() => null)) as SessionPayload | null;
      if (response.ok && payload?.authenticated) {
        setEmail(payload.user?.email ?? null);
        setStatus('authenticated');
        return 'authenticated';
      }
      const next: PlatformAdminStatus = response.status === 403 ? 'forbidden' : 'anonymous';
      setStatus(next);
      return next;
    } catch {
      setStatus('unavailable');
      return 'unavailable';
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await fetch('/api/admin/session', {
        method: 'DELETE',
        credentials: 'same-origin',
      });
    } catch {
      // La cookie se limpia igual en la próxima petición si expiró.
    }
    setEmail(null);
    setStatus('anonymous');
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { status, email, refresh, activate, signOut };
}
