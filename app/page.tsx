/**
 * Home global de UMANTAI — buscador local de productos y comercios.
 *
 * Server Component: la primera pintura ya trae tiendas y productos (sin
 * esperar al GPS ni a una segunda petición). El cliente `DiscoveryHome` toma el
 * control para geolocalización, radio y búsqueda incremental.
 *
 * No hay cards gigantes ni fotos de producto: la experiencia principal es una
 * lista densa, pensada para móvil.
 */

import type { Metadata } from 'next';
import { BrandLogo } from '@/components/brand/BrandLogo';
import { DiscoveryHome } from '@/app/components/discovery/DiscoveryHome';
import type { DiscoveryResponse } from '@/lib/discovery';
import { DEFAULT_RADIUS_KM } from '@/lib/geo';
import { isPlatformDbConfigured } from '@/lib/platform-db.server';
import { searchDiscovery } from '@/lib/stores.server';
import { getTranslator } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';

/**
 * Metadata por locale. El canonical es único (`/`) y las variantes no generan
 * URLs duplicadas: el idioma vive en cookie, no en la ruta.
 */
export async function generateMetadata(): Promise<Metadata> {
  const { locale, t } = await getTranslator();
  return {
    title: { absolute: t('home.metaTitle') },
    description: t('home.metaDescription'),
    alternates: { canonical: '/', languages: { es: '/', en: '/' } },
    openGraph: { locale: locale === 'en' ? 'en_US' : 'es_PE', url: '/' },
  };
}

const EMPTY: DiscoveryResponse = {
  products: [],
  stores: [],
  metadata: {
    q: '',
    location: null,
    radiusKm: DEFAULT_RADIUS_KM,
    limit: 30,
    offset: 0,
    total: 0,
    hasMore: false,
    generatedAt: new Date(0).toISOString(),
  },
};

async function loadInitial(): Promise<DiscoveryResponse> {
  if (!isPlatformDbConfigured()) return EMPTY;

  try {
    const { products, stores, total } = await searchDiscovery({
      q: '',
      location: null,
      radiusKm: DEFAULT_RADIUS_KM,
      limit: 30,
      offset: 0,
    });

    return {
      products,
      stores,
      metadata: {
        q: '',
        location: null,
        radiusKm: DEFAULT_RADIUS_KM,
        limit: 30,
        offset: 0,
        total,
        hasMore: products.length < total,
        generatedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    console.error('[home] no se pudo cargar el descubrimiento inicial', error);
    return EMPTY;
  }
}

export default async function HomePage() {
  const [{ t }, initial] = await Promise.all([getTranslator(), loadInitial()]);

  return (
    <main className="min-h-screen">
      <section className="mx-auto max-w-5xl px-5 pt-8 sm:pt-12">
        <BrandLogo size="lg" className="mb-5 block" />
        <h1 className="max-w-2xl text-3xl font-semibold leading-[1.1] tracking-[-1px] sm:text-5xl">
          {t('home.title')}
        </h1>
        <p className="mt-2 max-w-xl text-sm text-secondary sm:text-base">{t('home.subtitle')}</p>
      </section>

      <DiscoveryHome initial={initial} />

      <div className="h-6" />
    </main>
  );
}
