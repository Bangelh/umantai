import Link from 'next/link';
import { ChevronDown, Clock, MapPin, MessageCircle, ShieldCheck } from 'lucide-react';

import { BrandLogo } from '@/components/brand/BrandLogo';
import { businessConfig } from '@/config/business';
import { getTranslator } from '@/lib/i18n/server';
import type { Store, StorePayments } from '@/lib/stores.server';
import { whatsappUrl } from '@/lib/whatsapp';

interface Props {
  store: Store;
  payments: StorePayments | null;
  categories: Array<{ name: string; count: number }>;
  /** Horario que escribió la tienda; `null` si todavía no lo cargó. */
  hours: string | null;
  /** Solo se anuncia tarjeta si el cobro online está habilitado en el entorno. */
  cardPaymentsEnabled: boolean;
}

/**
 * Footer de la vitrina de una tienda.
 *
 * Sigue el orden que usa el comercio cuando alguien baja hasta el final para
 * comprobar si la tienda es real: primero con quién hablar (WhatsApp y
 * dirección), después cómo pagar, qué políticas aplican y quién vende. Las
 * categorías quedan plegadas para no repetir el muro de enlaces que hace
 * desconfiar.
 *
 * Solo muestra datos que existen: si la tienda no cargó WhatsApp, pagos o
 * dirección, se dice —no se inventa un horario, una garantía ni un RUC—. Los
 * datos legales del titular viven en `config/business.ts`; mientras sigan en
 * `null`, el bloque enlaza al aviso legal en lugar de imprimir un placeholder.
 */
export async function StoreFooter({
  store,
  payments,
  categories,
  hours,
  cardPaymentsEnabled,
}: Props) {
  const { t } = await getTranslator();

  const whatsappHref = store.whatsapp
    ? whatsappUrl(store.whatsapp, t('store.whatsappMessage', { store: store.name }))
    : null;
  const location = [store.address, store.district, store.city].filter(Boolean).join(' · ');

  const paymentMethods: string[] = [];
  if (payments?.yape) paymentMethods.push(t('storeFooter.payYape'));
  if (payments?.plin) paymentMethods.push(t('storeFooter.payPlin'));
  if (payments?.bankAccount) paymentMethods.push(t('storeFooter.payTransfer'));
  if (payments?.cash) paymentMethods.push(t('storeFooter.payCash'));
  if (cardPaymentsEnabled) paymentMethods.push(t('storeFooter.payCard'));

  const legalName = businessConfig.legalName?.trim();
  const ruc = businessConfig.ruc?.trim();

  return (
    <footer className="mt-10 border-t border-border pt-6 text-sm">
      {/* Con quién hablar: lo primero y con el botón más grande del footer. */}
      <div className="rounded-2xl border border-border bg-surface-raised/40 p-4 sm:flex sm:items-center sm:justify-between sm:gap-6 sm:p-5">
        <div className="min-w-0">
          <h2 className="text-body font-semibold text-primary">{t('storeFooter.contactTitle')}</h2>
          <p className="mt-1 max-w-md text-sm leading-relaxed text-secondary">
            {t('storeFooter.contactBody')}
          </p>
          {location && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-tertiary">
              <MapPin aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{location}</span>
            </p>
          )}
          {hours && (
            <p className="mt-1 flex items-start gap-1.5 text-xs text-tertiary">
              <Clock aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                <span className="sr-only">{t('storeFooter.hours')}: </span>
                {hours}
              </span>
            </p>
          )}
        </div>
        <div className="mt-3 sm:mt-0 sm:shrink-0">
          {whatsappHref ? (
            <a
              href={whatsappHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-brand px-4 text-sm font-semibold text-background transition-opacity hover:opacity-90 sm:w-auto"
            >
              <MessageCircle aria-hidden="true" className="h-4 w-4" />
              {t('storeFooter.whatsappCta')}
            </a>
          ) : (
            <p className="text-xs text-tertiary">{t('storeFooter.noWhatsapp')}</p>
          )}
        </div>
      </div>

      <div className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        <section aria-labelledby="store-footer-payments">
          <h2
            id="store-footer-payments"
            className="text-xs font-semibold uppercase tracking-[2px] text-tertiary"
          >
            {t('storeFooter.paymentsTitle')}
          </h2>
          {paymentMethods.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {paymentMethods.map((method) => (
                <li
                  key={method}
                  className="rounded-lg border border-border bg-surface px-2.5 py-1 text-xs font-medium text-secondary"
                >
                  {method}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-xs leading-relaxed text-tertiary">{t('storeFooter.noPayments')}</p>
          )}
        </section>

        <nav aria-labelledby="store-footer-policies">
          <h2
            id="store-footer-policies"
            className="text-xs font-semibold uppercase tracking-[2px] text-tertiary"
          >
            {t('storeFooter.policiesTitle')}
          </h2>
          <ul className="mt-2 space-y-1.5 text-sm">
            <li>
              <Link href="/legal/reembolsos" className="text-secondary hover:text-primary">
                {t('navLink.refunds')}
              </Link>
            </li>
            <li>
              <Link href="/legal/privacidad" className="text-secondary hover:text-primary">
                {t('legal.privacy')}
              </Link>
            </li>
            <li>
              <Link href="/legal/terminos" className="text-secondary hover:text-primary">
                {t('legal.terms')}
              </Link>
            </li>
            <li>
              <Link
                href="/libro-de-reclamaciones"
                className="text-secondary hover:text-primary"
              >
                {t('navLink.complaintsBook')}
              </Link>
            </li>
          </ul>
        </nav>

        <section aria-labelledby="store-footer-seller">
          <h2
            id="store-footer-seller"
            className="text-xs font-semibold uppercase tracking-[2px] text-tertiary"
          >
            {t('storeFooter.sellerTitle')}
          </h2>
          <p className="mt-2 text-sm font-medium text-primary">{store.name}</p>
          {location && <p className="mt-0.5 text-xs leading-relaxed text-tertiary">{location}</p>}
          {(legalName || ruc) && (
            <dl className="mt-2 space-y-0.5 text-xs text-tertiary">
              {legalName && (
                <div className="flex gap-1.5">
                  <dt>{t('storeFooter.sellerLegal')}:</dt>
                  <dd className="text-secondary">{legalName}</dd>
                </div>
              )}
              {ruc && (
                <div className="flex gap-1.5">
                  <dt>{t('storeFooter.sellerRuc')}:</dt>
                  <dd className="text-secondary tabular-nums">{ruc}</dd>
                </div>
              )}
            </dl>
          )}
          <Link
            href="/legal/aviso-legal"
            className="mt-2 inline-block text-xs text-tertiary underline-offset-2 hover:text-primary hover:underline"
          >
            {t('storeFooter.legalLink')}
          </Link>
        </section>
      </div>

      <p className="mt-5 flex items-start gap-2 rounded-xl border border-border bg-surface px-3 py-2.5 text-xs leading-relaxed text-tertiary">
        <ShieldCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-success" />
        <span>{t('storeFooter.trust')}</span>
      </p>

      {categories.length > 0 && (
        <details className="group mt-4 rounded-2xl border border-border bg-surface">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
            <span className="text-sm font-medium text-secondary">
              {t('storeFooter.openCategories', { count: categories.length })}
            </span>
            <ChevronDown
              aria-hidden="true"
              className="h-4 w-4 shrink-0 text-tertiary transition-transform group-open:rotate-180"
            />
          </summary>
          <ul className="flex flex-wrap gap-1.5 border-t border-border p-4">
            {categories.map((category) => (
              <li key={category.name}>
                <Link
                  href={`/${store.slug}?category=${encodeURIComponent(category.name)}`}
                  className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs text-secondary hover:border-border-strong hover:text-primary"
                >
                  {category.name}
                  <span className="text-[10px] text-muted tabular-nums">{category.count}</span>
                </Link>
              </li>
            ))}
          </ul>
          <p className="px-4 pb-4 text-[11px] text-muted">{t('storeFooter.categoriesHint')}</p>
        </details>
      )}

      <div className="mt-6 flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-xs text-tertiary">
          {t('store.soldBy', { store: store.name })}
        </span>
        <div className="flex items-center gap-4">
          <Link href="/vender" className="text-xs text-tertiary hover:text-primary">
            {t('store.sellCta')}
          </Link>
          <span className="opacity-60">
            <BrandLogo size="sm" />
          </span>
        </div>
      </div>
    </footer>
  );
}
