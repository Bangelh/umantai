import type { Metadata } from 'next';
import Link from 'next/link';

import {
  PENDING_BUSINESS_FIELDS,
  businessConfig,
  pendingBusinessFields,
} from '@/config/business';
import { LEGAL_DOCUMENTS, LEGAL_SLUGS } from '@/lib/legal';

export const metadata: Metadata = {
  title: `Legal | ${businessConfig.name}`,
  description:
    'Política de privacidad, términos y condiciones, reembolsos, cookies y aviso legal de Umantai.',
  alternates: { canonical: `${businessConfig.siteUrl}/legal` },
};

export default function LegalIndexPage() {
  const pending = pendingBusinessFields();

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

      {pending.length > 0 && (
        <p className="mt-4 rounded-2xl border border-warning/40 bg-warning/10 p-4 text-sm text-warning">
          Estos documentos no son definitivos para lanzamiento público. Faltan:{' '}
          {pending.map((field) => PENDING_BUSINESS_FIELDS[field]).join(', ')}.
        </p>
      )}

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

      <section className="surface-card mt-8 p-5">
        <h2 className="font-medium text-primary">Libro de Reclamaciones</h2>
        <p className="mt-2 text-sm text-secondary">
          Canal permanente para presentar quejas y reclamos sobre productos o servicios, con
          respuesta en un plazo máximo de 15 días hábiles.
        </p>
        <Link
          href="/libro-de-reclamaciones"
          className="mt-3 inline-block text-sm underline underline-offset-4 hover:text-primary"
        >
          Ir al Libro de Reclamaciones
        </Link>
      </section>

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
