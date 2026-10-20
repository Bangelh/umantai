/**
 * components/brand/AuthLink.tsx — "Ingresar" público / "Mi cuenta" con sesión.
 *
 * Server Component: la sesión se resuelve con Better Auth en el servidor, así
 * no hay parpadeo ni un endpoint extra en la primera pintura.
 */

import Link from 'next/link';
import { getCurrentUser } from '@/lib/current-user.server';
import { getTranslator } from '@/lib/i18n/server';

export async function AuthLink() {
  const [user, { t }] = await Promise.all([getCurrentUser(), getTranslator()]);

  if (!user) {
    return (
      <Link
        href="/ingresar"
        className="inline-flex h-9 items-center justify-center rounded-full border border-border-strong px-4 text-sm font-medium text-primary transition-colors hover:bg-surface-raised"
      >
        {t('nav.login')}
      </Link>
    );
  }

  const firstName = user.name.trim().split(/\s+/)[0] || t('nav.account');

  return (
    <Link
      href="/cuenta"
      className="inline-flex h-9 items-center justify-center rounded-full border border-border-strong px-4 text-sm font-medium text-primary transition-colors hover:bg-surface-raised"
    >
      {firstName}
    </Link>
  );
}
