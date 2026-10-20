/**
 * /ingresar — una sola identidad para clientes y comerciantes.
 *
 * No hay dos formularios ni dos tablas de usuarios: quien se registra puede
 * comprar y, más adelante, crear una tienda (`/vender`) con la misma cuenta.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AuthForm } from './AuthForm';
import { getCurrentUser } from '@/lib/current-user.server';
import { getTranslator } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslator();
  return {
    title: t('nav.login'),
    description: t('home.subtitle'),
    robots: { index: false, follow: false },
  };
}

interface PageProps {
  searchParams: Promise<{ next?: string | string[] }>;
}

function safeNext(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/cuenta';
  return value;
}

export default async function LoginPage({ searchParams }: PageProps) {
  const { t } = await getTranslator();
  const user = await getCurrentUser();
  const { next } = await searchParams;
  const destination = safeNext(next);

  if (user) redirect(destination);

  return (
    <main className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-5 py-10">
      <div className="rounded-3xl border border-border bg-surface p-6 sm:p-8">
        <h1 className="text-2xl font-semibold tracking-tight">{t('nav.login')}</h1>
        <p className="mt-1 text-sm text-secondary">{t('auth.guest')}</p>
        <AuthForm next={destination} />
      </div>

      <p className="mt-5 text-center text-xs text-muted">
        <Link href="/legal/terminos" className="underline underline-offset-2 hover:text-primary">
          {t('legal.terms')}
        </Link>{' '}
        ·{' '}
        <Link href="/legal/privacidad" className="underline underline-offset-2 hover:text-primary">
          {t('legal.privacy')}
        </Link>
      </p>
    </main>
  );
}
