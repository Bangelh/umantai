import type { Metadata } from 'next';
import Link from 'next/link';

import { businessConfig } from '@/config/business';
import { ContactForm } from './ContactForm';

export const metadata: Metadata = {
  title: `Contacto | ${businessConfig.name}`,
  description:
    'Escríbenos por dudas sobre un pedido, disponibilidad, retiro o cualquier consulta. También puedes contactarnos por WhatsApp.',
  alternates: { canonical: `${businessConfig.siteUrl}/contacto` },
  openGraph: {
    type: 'website',
    title: `Contacto | ${businessConfig.name}`,
    description: 'Atención al cliente y consultas sobre pedidos.',
    url: `${businessConfig.siteUrl}/contacto`,
    siteName: businessConfig.name,
  },
};

function whatsappLink(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 8 ? `https://wa.me/${digits}` : null;
}

export default function ContactPage() {
  const whatsapp = whatsappLink(businessConfig.whatsapp);

  return (
    <main lang="es" className="mx-auto max-w-6xl px-5 py-12 sm:px-8 sm:py-16">
      <nav aria-label="Ruta de navegación" className="mb-6 text-sm text-tertiary">
        <Link href="/" className="hover:text-primary">
          Inicio
        </Link>
        <span aria-hidden="true"> / </span>
        <span className="text-secondary">Contacto</span>
      </nav>

      <header className="max-w-2xl">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Contacto</h1>
        <p className="mt-3 text-sm text-secondary sm:text-base">
          Dudas sobre un pedido, un retiro, disponibilidad o cualquier consulta. Cuéntanos qué
          necesitas y te respondemos al correo que indiques.
        </p>
      </header>

      <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <ContactForm />

        <aside className="space-y-4">
          <section className="surface-card p-5">
            <h2 className="text-sm font-medium uppercase tracking-wide text-tertiary">Canales</h2>
            <ul className="mt-3 space-y-2 text-sm">
              <li className="text-secondary">
                <span className="text-tertiary">Correo: </span>
                {businessConfig.email ?? (
                  <span className="text-warning">[PENDIENTE: definir correo de atención]</span>
                )}
              </li>
              <li className="text-secondary">
                <span className="text-tertiary">WhatsApp: </span>
                {whatsapp ? (
                  <a
                    href={whatsapp}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-4 hover:text-primary"
                  >
                    Abrir conversación
                  </a>
                ) : (
                  <span className="text-warning">[PENDIENTE: configurar WhatsApp]</span>
                )}
              </li>
              <li className="text-secondary">
                <span className="text-tertiary">Dirección: </span>
                <span className="text-warning">[PENDIENTE: definir dirección]</span>
              </li>
            </ul>
          </section>

          <section className="surface-card p-5 text-sm text-secondary">
            <h2 className="text-sm font-medium uppercase tracking-wide text-tertiary">
              Pedidos y retiros
            </h2>
            <p className="mt-3">
              Si ya hiciste un pedido, revisa su estado en tu enlace de pedido. Para retirar,
              presenta el PIN que te enviamos; no lo compartas con nadie.
            </p>
          </section>

          <p className="text-xs leading-relaxed text-tertiary">
            Al enviar el formulario aceptas nuestra{' '}
            <Link href="/legal/privacidad" className="underline underline-offset-4 hover:text-primary">
              Política de Privacidad
            </Link>
            . Solo usamos tus datos para responderte.
          </p>
        </aside>
      </div>
    </main>
  );
}
