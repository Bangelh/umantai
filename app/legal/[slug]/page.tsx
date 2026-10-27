import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  PENDING_BUSINESS_FIELDS,
  businessConfig,
  isLegalDemoDataActive,
  isLegalReadyForLaunch,
  pendingBusinessFields,
} from '@/config/business';
import { LegalDemoNotice } from '@/components/legal/LegalDemoNotice';
import {
  LEGAL_DRAFT_NOTICE,
  LEGAL_LAST_UPDATED,
  LEGAL_SLUGS,
  getLegalDocument,
} from '@/lib/legal';

interface LegalPageProps {
  params: Promise<{ slug: string }>;
}

export function generateStaticParams() {
  return LEGAL_SLUGS.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: LegalPageProps): Promise<Metadata> {
  const { slug } = await params;
  const document = getLegalDocument(slug);
  if (!document) return { title: 'Documento no encontrado' };

  const canonical = `${businessConfig.siteUrl}/legal/${document.slug}`;
  return {
    title: `${document.title} | ${businessConfig.name}`,
    description: document.description,
    alternates: { canonical },
    openGraph: {
      type: 'article',
      title: `${document.title} | ${businessConfig.name}`,
      description: document.description,
      url: canonical,
      siteName: businessConfig.name,
    },
  };
}

export default async function LegalPage({ params }: LegalPageProps) {
  const { slug } = await params;
  const document = getLegalDocument(slug);
  if (!document) notFound();

  const pending = pendingBusinessFields();

  return (
    <main lang="es" className="mx-auto max-w-3xl px-5 py-12 sm:px-8 sm:py-16">
      <nav aria-label="Ruta de navegación" className="mb-6 text-sm text-tertiary">
        <Link href="/" className="hover:text-primary">
          Inicio
        </Link>
        <span aria-hidden="true"> / </span>
        <Link href="/legal" className="hover:text-primary">
          Legal
        </Link>
        <span aria-hidden="true"> / </span>
        <span className="text-secondary">{document.title}</span>
      </nav>

      <header>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{document.title}</h1>
        <p className="mt-2 text-sm text-secondary">{document.description}</p>
      </header>

      <div
        role="note"
        className="mt-6 rounded-2xl border border-warning/40 bg-warning/10 p-4 text-sm text-warning"
      >
        <strong className="font-semibold">Documento en borrador.</strong> {LEGAL_DRAFT_NOTICE}
        {!isLegalReadyForLaunch() && (
          <p className="mt-2">
            No puede considerarse definitivo para lanzamiento público: faltan{' '}
            {pending.map((field) => PENDING_BUSINESS_FIELDS[field]).join(', ')}.
          </p>
        )}
      </div>

      {isLegalDemoDataActive() && <LegalDemoNotice />}

      <div className="mt-10 space-y-10">
        {document.sections.map((section) => (
          <section key={section.heading} aria-labelledby={`section-${section.heading}`}>
            <h2 id={`section-${section.heading}`} className="text-lg font-medium text-primary">
              {section.heading}
            </h2>
            <div className="mt-3 space-y-3 text-sm leading-relaxed text-secondary sm:text-base">
              {section.paragraphs.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </div>
          </section>
        ))}
      </div>

      <footer className="mt-12 border-t border-border pt-6 text-sm text-tertiary">
        <p>
          Última revisión del borrador: <time dateTime={LEGAL_LAST_UPDATED}>{LEGAL_LAST_UPDATED}</time>.
        </p>
        <p className="mt-2">
          ¿Consultas?{' '}
          <Link href="/contacto" className="underline underline-offset-4 hover:text-primary">
            Escríbenos
          </Link>
          .
        </p>
        <p className="mt-2">
          ¿Quieres presentar una queja o reclamo?{' '}
          <Link
            href="/libro-de-reclamaciones"
            className="underline underline-offset-4 hover:text-primary"
          >
            Libro de Reclamaciones
          </Link>
          .
        </p>
        <Link href="/legal" className="mt-4 inline-block hover:text-primary">
          ← Todos los documentos legales
        </Link>
      </footer>
    </main>
  );
}
