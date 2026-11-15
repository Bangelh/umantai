'use client';

/**
 * components/admin/AdminAccessScreen.tsx — puerta de los paneles /admin.
 *
 * La persona entra directamente con su correo y contraseña de Platform Admin.
 * No hay botón de "activar sesión" ni campo de token.
 *
 * Flujo:
 *   1. Si ya existe la cookie firmada de admin, el panel ni siquiera llega acá.
 *   2. Si hay una sesión de Better Auth autorizada, se canjea sola por la cookie.
 *   3. Si no hay sesión, se muestra el formulario de acceso.
 *   4. Si la cuenta existe pero no es Platform Admin, se explica el 403.
 */

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

import { AuthForm } from '@/app/ingresar/AuthForm';
import { useI18n } from '@/components/i18n/I18nProvider';
import type { PlatformAdminStatus } from '@/lib/usePlatformAdminSession';

interface Props {
  /** Nombre del panel; se usa como etiqueta accesible, no como título visible. */
  title: string;
  status: PlatformAdminStatus;
  onActivate: () => Promise<PlatformAdminStatus>;
  /** Texto opcional debajo del título (no se traduce: nombre del panel). */
  subtitle?: string;
}

export function AdminAccessScreen({ title, status, onActivate }: Props) {
  const { t } = useI18n();
  const pathname = usePathname();
  const autoActivated = useRef(false);

  // Si la persona ya inició sesión con una cuenta autorizada pero todavía no
  // tiene la cookie de admin, se canjea una vez sin pedirle otro botón.
  useEffect(() => {
    if (status !== 'anonymous' || autoActivated.current) return;
    autoActivated.current = true;
    void onActivate();
  }, [status, onActivate]);

  const next = pathname || '/admin';

  return (
    <main
      aria-label={title}
      className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-5 py-10"
    >
      <div className="rounded-3xl border border-border bg-surface p-6 sm:p-8">
        <p className="text-xs uppercase tracking-[2px] text-muted">Platform Admin</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t('adminLogin.title')}</h1>
        <p className="mt-2 text-sm text-secondary">{t('adminLogin.body')}</p>

        {status === 'unavailable' && (
          <p
            role="alert"
            className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          >
            {t('common.error')}
          </p>
        )}

        {status === 'forbidden' && (
          <p
            role="alert"
            className="mt-4 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-warning"
          >
            {t('admin.notAuthorized')}
          </p>
        )}

        {(status === 'checking' || status === 'anonymous') && (
          <AuthForm next={next} fullReload />
        )}
      </div>
    </main>
  );
}
