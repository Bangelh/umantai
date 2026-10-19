import type { Metadata } from 'next';
import Link from 'next/link';

import { businessConfig } from '@/config/business';
import { LEGAL_DOCUMENTS, LEGAL_SLUGS } from '@/lib/legal';

export const metadata: Metadata = {
  title: `Legal | ${businessConfig.name}`,
  description:
    'Política de privacidad, términos y condiciones, reembolsos, cookies y aviso legal de Umantai.',
  alternates: { canonical: `${businessConfig.siteUrl}/legal` },
};

export default function LegalIndexPage() {
  return (
    <main lang="es" className="mx-auto max-w-3xl px-5 py-12 sm:px-8 sm:py-16">
      <nav aria-label="Ruta de navegación" className="mb-6 text-sm text-tertiary">
        <Link href="/" className="hover:text-primary">
          Inicio
        </Link>
        <span aria-hidden="true"> / </span>
        <span className="text-secondary">Legal</span>
      </nav>

      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Legal</h1>
      <p className="mt-2 max-w-xl text-sm text-secondary sm:text-base">
        Documentos operativos de {businessConfig.name}. Los datos que el negocio todavía no
        confirmó aparecen marcados como <span className="text-warning">pendientes</span>, nunca
        inventados.
      </p>

      <ul className="mt-8 space-y-3">
        {LEGAL_SLUGS.map((slug) => {
          const document = LEGAL_DOCUMENTS[slug];
          return (
            <li key={slug}>
              <Link
                href={`/legal/${document.slug}`}
                className="surface-card flex flex-col gap-1 p-5 transition-colors hover:border-border-strong"
              >
                <span className="font-medium text-primary">{document.title}</span>
                <span className="text-sm text-tertiary">{document.description}</span>
              </Link>
            </li>
          );
        })}
      </ul>

      <p className="mt-8 text-sm text-secondary">
        Para consultas sobre estos documentos,{' '}
        <Link href="/contacto" className="underline underline-offset-4 hover:text-primary">
          usa el formulario de contacto
        </Link>
        .
      </p>
    </main>
  );
}
