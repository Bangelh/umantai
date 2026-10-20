import type { Metadata } from 'next';
import Link from 'next/link';

import { businessConfig } from '@/config/business';
import { getTranslator } from '@/lib/i18n/server';
import { ContactForm } from './ContactForm';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslator();
  return {
    title: `${t('contact.title')} | ${businessConfig.name}`,
    description: t('contact.metaDescription'),
    alternates: { canonical: `${businessConfig.siteUrl}/contacto` },
    openGraph: {
      type: 'website',
      title: `${t('contact.title')} | ${businessConfig.name}`,
      description: t('contact.openGraphDescription'),
      url: `${businessConfig.siteUrl}/contacto`,
      siteName: businessConfig.name,
    },
  };
}

function whatsappLink(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 8 ? `https://wa.me/${digits}` : null;
}

export default async function ContactPage() {
  const { t } = await getTranslator();
  const whatsapp = whatsappLink(businessConfig.whatsapp);

  return (
    <main className="mx-auto max-w-6xl px-5 py-12 sm:px-8 sm:py-16">
      <nav aria-label={t('contact.breadcrumb')} className="mb-6 text-sm text-tertiary">
        <Link href="/" className="hover:text-primary">
          {t('contact.home')}
        </Link>
        <span aria-hidden="true"> / </span>
        <span className="text-secondary">{t('contact.title')}</span>
      </nav>

      <header className="max-w-2xl">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{t('contact.title')}</h1>
        <p className="mt-3 text-sm text-secondary sm:text-base">{t('contact.intro')}</p>
      </header>

      <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <ContactForm />

        <aside className="space-y-4">
          <section className="surface-card p-5">
            <h2 className="text-sm font-medium uppercase tracking-wide text-tertiary">{t('contact.channels')}</h2>
            <ul className="mt-3 space-y-2 text-sm">
              <li className="text-secondary">
                <span className="text-tertiary">{t('contact.email')} </span>
                {businessConfig.email ?? (
                  <span className="text-warning">{t('contact.emailPending')}</span>
                )}
              </li>
              <li className="text-secondary">
                <span className="text-tertiary">{t('contact.whatsapp')} </span>
                {whatsapp ? (
                  <a
                    href={whatsapp}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-4 hover:text-primary"
                  >
                    {t('contact.openChat')}
                  </a>
                ) : (
                  <span className="text-warning">{t('contact.whatsappPending')}</span>
                )}
              </li>
              <li className="text-secondary">
                <span className="text-tertiary">{t('contact.address')} </span>
                <span className="text-warning">{t('contact.addressPending')}</span>
              </li>
            </ul>
          </section>

          <section className="surface-card p-5 text-sm text-secondary">
            <h2 className="text-sm font-medium uppercase tracking-wide text-tertiary">
              {t('contact.ordersTitle')}
            </h2>
            <p className="mt-3">{t('contact.ordersBody')}</p>
          </section>

          <p className="text-xs leading-relaxed text-tertiary">
            {t('contact.consentPrefix')}{' '}
            <Link href="/legal/privacidad" className="underline underline-offset-4 hover:text-primary">
              {t('contact.privacyLink')}
            </Link>
            {t('contact.consentSuffix')}
          </p>
        </aside>
      </div>
    </main>
  );
}
