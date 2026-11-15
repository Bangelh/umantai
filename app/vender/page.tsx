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

  const features = [
    { title: t('sell.catalog'), text: t('sell.catalogBody') },
    { title: t('sell.orders'), text: t('sell.ordersBody') },
    { title: t('sell.inventory'), text: t('sell.inventoryBody') },
    { title: t('sell.analytics'), text: t('sell.analyticsBody') },
  ];

  const steps = [
    { title: t('sell.step1Title'), text: t('sell.step1Body') },
    { title: t('sell.step2Title'), text: t('sell.step2Body') },
    { title: t('sell.step3Title'), text: t('sell.step3Body') },
  ];

  return (
    <main className="mx-auto max-w-3xl px-4 pb-14 pt-6 sm:px-6">
      <p className="text-xs uppercase tracking-[2px] text-muted">{t('sell.kicker')}</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight sm:text-4xl">{t('sell.title')}</h1>
      <p className="mt-2 max-w-2xl text-body text-secondary">{t('sell.intro')}</p>

      {!user && (
        <>
          <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Link
              href="/ingresar?next=/vender&mode=register"
              className="inline-flex h-12 items-center justify-center rounded-xl bg-brand px-5 text-base font-semibold text-background hover:opacity-90"
            >
              {t('sell.signIn')}
            </Link>
            <Link
              href="/ingresar?next=/vender"
              className="inline-flex h-12 items-center justify-center rounded-xl border border-border-strong px-5 text-base font-medium hover:bg-surface-raised"
            >
              {t('sell.haveAccount')}
            </Link>
            <Link
              href="#planes"
              className="inline-flex h-12 items-center justify-center px-2 text-sm text-tertiary underline-offset-4 hover:text-primary hover:underline"
            >
              {t('sell.seePlans')}
            </Link>
          </div>
          <p className="mt-2 text-sm font-medium text-success">{t('sell.planPilot')}</p>
        </>
      )}

      <section aria-label={t('sell.featuresAria')} className="mt-8 grid gap-x-6 gap-y-4 sm:grid-cols-2">
        {features.map((item, index) => (
          <div key={item.title} className="border-t border-border pt-3">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-xs text-muted">0{index + 1}</span>
              <h2 className="text-base font-semibold">{item.title}</h2>
            </div>
            <p className="mt-1 text-sm leading-relaxed text-secondary">{item.text}</p>
          </div>
        ))}
      </section>

      <section aria-labelledby="sell-how-it-works" className="mt-10">
        <h2 id="sell-how-it-works" className="border-b border-border pb-2 text-sm font-semibold uppercase tracking-[2px] text-secondary">
          {t('sell.howItWorks')}
        </h2>
        <ol className="mt-4 grid gap-4 sm:grid-cols-3">
          {steps.map((step, index) => (
            <li key={step.title} className="border-t border-border pt-3">
              <span className="font-mono text-xs text-muted">0{index + 1}</span>
              <h3 className="mt-1 text-base font-semibold">{step.title}</h3>
              <p className="mt-1 text-sm leading-relaxed text-secondary">{step.text}</p>
            </li>
          ))}
        </ol>
      </section>

      {user && (
        <section className="mt-10">
          <h2 className="border-b border-border pb-2 text-sm font-semibold uppercase tracking-[2px] text-secondary">
            {t('sell.businessData')}
          </h2>
          <MerchantOnboardingForm />
        </section>
      )}

      <section id="planes" className="mt-10 scroll-mt-24 rounded-2xl border border-border bg-surface p-5 sm:p-6">
        <h2 className="text-lg font-semibold">{t('sell.plans')}</h2>
        <p className="mt-1 text-sm leading-relaxed text-secondary">{t('sell.plansBody')}</p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-secondary">
          <li>{t('sell.planPilot')}</li>
          <li>{t('sell.planNoCommission')}</li>
          <li>{t('sell.planPaymentsFrozen')}</li>
        </ul>
      </section>

      <p className="mt-6 text-xs text-muted">
        {user ? t('sell.legalPrefix') : t('sell.legalAccountPrefix')}{' '}
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
