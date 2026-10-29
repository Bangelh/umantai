/**
 * /cuenta/verificado — destino del enlace de verificación de correo.
 *
 * Better Auth (`GET /api/auth/verify-email`) marca `emailVerified = true`, inicia
 * sesión si hace falta y redirige a `callbackURL`. Antes el callback por defecto
 * era `/`, así que el usuario aterrizaba en la home sin saber si había funcionado.
 *
 * Si el token venció o ya se usó, Better Auth redirige acá con `?error=…`; se
 * muestra un mensaje claro y la salida (pedir otro enlace desde /cuenta).
 */

import type { Metadata } from 'next';
import Link from 'next/link';

import { getTranslator } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslator();
  return { title: t('verify.title'), robots: { index: false, follow: false } };
}

interface PageProps {
  searchParams: Promise<{ error?: string | string[] }>;
}

export default async function VerifiedPage({ searchParams }: PageProps) {
  const { t } = await getTranslator();
  const { error } = await searchParams;
  const raw = Array.isArray(error) ? error[0] : error;
  const failed = typeof raw === 'string' && raw.trim().length > 0;

  return (
    <main className="mx-auto max-w-2xl px-4 pb-12 pt-10 sm:px-6">
      <div
        role={failed ? 'alert' : 'status'}
        className={`rounded-2xl border p-6 ${
          failed ? 'border-destructive/40 bg-destructive/10' : 'border-success/40 bg-success/10'
        }`}
      >
        <h1
          className={`text-2xl font-semibold tracking-tight ${
            failed ? 'text-destructive' : 'text-success'
          }`}
        >
          {failed ? t('verify.errorTitle') : t('verify.title')}
        </h1>
        <p className="mt-2 text-base text-secondary">
          {failed ? t('verify.expired') : t('verify.success')}
        </p>

        <div className="mt-5 flex flex-wrap gap-2">
          <Link
            href="/cuenta"
            className="inline-flex h-11 items-center rounded-xl bg-brand px-4 text-sm font-semibold text-background"
          >
            {t('verify.backToAccount')}
          </Link>
          {failed && (
            <Link
              href="/cuenta"
              className="inline-flex h-11 items-center rounded-xl border border-border-strong px-4 text-sm font-medium hover:bg-surface-raised"
            >
              {t('account.resendVerification')}
            </Link>
          )}
        </div>
      </div>
    </main>
  );
}
