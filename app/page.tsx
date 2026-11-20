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
import { DiscoveryHome } from '@/app/components/discovery/DiscoveryHome';
import { AuroraBackdrop } from '@/components/ui/AuroraBackdrop';
import type { DiscoveryResponse } from '@/lib/discovery';
import { DEFAULT_RADIUS_KM } from '@/lib/geo';
import { isPlatformDbConfigured } from '@/lib/platform-db.server';
import { searchDiscovery } from '@/lib/stores.server';
import { getTranslator } from '@/lib/i18n/server';
import { whatsappUrl } from '@/config/business';

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
  const businessWhatsAppUrl = whatsappUrl(t('home.businessWhatsAppMessage'));

  return (
    <main className="min-h-screen">
      {/* El logo ya está en el header: repetirlo en grande acá dejaba dos marcas
          compitiendo antes de la pregunta que el comprador tiene que responder.
          La atmósfera (blobs difusos + retícula) es SVG/CSS, sin imagen externa. */}
      <section className="relative isolate overflow-hidden">
        <AuroraBackdrop />
        <div className="relative mx-auto max-w-5xl px-4 pb-1 pt-10 sm:px-6 sm:pt-14">
          <div className="max-w-3xl">
            <h1 className="text-balance text-[2.3rem] font-semibold leading-[1.02] tracking-[-0.045em] sm:text-[3.75rem]">
              {t('home.title')}
            </h1>
            <p className="mt-4 max-w-xl text-pretty text-body-lg text-secondary">
              {t('home.subtitle')}
            </p>
          </div>
        </div>
      </section>

      <DiscoveryHome initial={initial} businessWhatsAppUrl={businessWhatsAppUrl} />

      <div className="h-6" />
    </main>
  );
}
