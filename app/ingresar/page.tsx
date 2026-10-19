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

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Ingresar',
  description: 'Ingresa a UMANTAI para ver tus pedidos o administrar tu tienda.',
  robots: { index: false, follow: false },
};

interface PageProps {
  searchParams: Promise<{ next?: string | string[] }>;
}

function safeNext(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/cuenta';
  return value;
}

export default async function LoginPage({ searchParams }: PageProps) {
  const user = await getCurrentUser();
  const { next } = await searchParams;
  const destination = safeNext(next);

  if (user) redirect(destination);

  return (
    <main className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-5 py-10">
      <div className="rounded-3xl border border-border bg-surface p-6 sm:p-8">
        <h1 className="text-2xl font-semibold tracking-tight">Ingresa a UMANTAI</h1>
        <p className="mt-1 text-sm text-secondary">
          La misma cuenta sirve para comprar y para administrar tu negocio.
        </p>
        <AuthForm next={destination} />
      </div>

      <p className="mt-5 text-center text-xs text-muted">
        Al continuar aceptas los{' '}
        <Link href="/legal/terminos" className="underline underline-offset-2 hover:text-primary">
          términos
        </Link>{' '}
        y la{' '}
        <Link href="/legal/privacidad" className="underline underline-offset-2 hover:text-primary">
          política de privacidad
        </Link>
        .
      </p>
    </main>
  );
}
