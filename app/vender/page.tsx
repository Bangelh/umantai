/**
 * /vender — "Quiero vender en UMANTAI".
 *
 * Alta controlada: el formulario crea la Store INACTIVA y la asocia al usuario
 * como owner. Un administrador la activa luego. NO se inventa cobro ni plan:
 * la sección de planes dice explícitamente que esta fase no cobra y deja el
 * gancho para asociar Plan más adelante.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { MerchantOnboardingForm } from './MerchantOnboardingForm';
import { getCurrentUser } from '@/lib/current-user.server';
import { getTranslator } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslator();
  return {
    title: t('sell.title'),
    description: t('sell.metaDescription'),
    alternates: { canonical: '/vender' },
  };
}

export default async function SellPage() {
  const { t } = await getTranslator();
  const user = await getCurrentUser();

  return (
    <main className="mx-auto max-w-3xl px-4 pb-14 pt-6 sm:px-6">
      <p className="text-xs uppercase tracking-[2px] text-muted">{t('sell.kicker')}</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight sm:text-4xl">{t('sell.title')}</h1>
      <p className="mt-2 max-w-2xl text-sm text-secondary sm:text-base">{t('sell.intro')}</p>

      <section aria-label={t('sell.featuresAria')} className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { title: t('sell.catalog'), text: t('sell.catalogBody') },
          { title: t('sell.orders'), text: t('sell.ordersBody') },
          { title: t('sell.inventory'), text: t('sell.inventoryBody') },
          { title: t('sell.analytics'), text: t('sell.analyticsBody') },
        ].map((item) => (
          <div key={item.title} className="rounded-xl border border-border bg-surface p-3">
            <div className="text-sm font-semibold">{item.title}</div>
            <div className="mt-0.5 text-xs text-tertiary">{item.text}</div>
          </div>
        ))}
      </section>

      {user ? (
        <section className="mt-8">
          <h2 className="border-b border-border pb-2 text-sm font-semibold uppercase tracking-[2px] text-secondary">
            {t('sell.businessData')}
          </h2>
          <MerchantOnboardingForm />
        </section>
      ) : (
        <section className="mt-8 rounded-2xl border border-border bg-surface p-5">
          <h2 className="text-lg font-semibold">{t('sell.accountFirstTitle')}</h2>
          <p className="mt-1 text-sm text-secondary">{t('sell.accountFirstBody')}</p>
          <Link
            href="/ingresar?next=/vender"
            className="mt-4 inline-flex h-11 items-center rounded-xl bg-brand px-5 text-sm font-semibold text-background"
          >
            {t('sell.signIn')}
          </Link>
        </section>
      )}

      <section id="planes" className="mt-10 scroll-mt-24 rounded-2xl border border-border bg-surface p-5">
        <h2 className="text-lg font-semibold">{t('sell.plans')}</h2>
        <p className="mt-1 text-sm text-secondary">{t('sell.plansBody')}</p>
        <ul className="mt-3 space-y-1 text-sm text-tertiary">
          <li>{t('sell.planPilot')}</li>
          <li>{t('sell.planNoCommission')}</li>
          <li>{t('sell.planPaymentsFrozen')}</li>
        </ul>
      </section>

      <p className="mt-6 text-xs text-muted">
        {t('sell.legalPrefix')}{' '}
        <Link href="/legal/terminos" className="underline underline-offset-2 hover:text-primary">
          {t('sell.terms')}
        </Link>{' '}
        {t('sell.legalAnd')}{' '}
        <Link href="/legal/privacidad" className="underline underline-offset-2 hover:text-primary">
          {t('sell.privacy')}
        </Link>
        {t('sell.legalSuffix')}
      </p>
    </main>
  );
}
