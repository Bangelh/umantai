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

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'UMANTAI | Encuentra productos y comercios cerca de ti',
  description:
    'Busca arroz, polo, tela, martillo, zapatos y más en las tiendas de UMANTAI. Resultados por cercanía, precio y disponibilidad.',
  alternates: { canonical: '/' },
};

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
  const initial = await loadInitial();

  return (
    <main className="min-h-screen">
      <section className="mx-auto max-w-5xl px-5 pt-8 sm:pt-12">
        <BrandLogo size="lg" className="mb-5 block" />
        <h1 className="max-w-2xl text-3xl font-semibold leading-[1.1] tracking-[-1px] sm:text-5xl">
          ¿Qué estás buscando?
        </h1>
        <p className="mt-2 max-w-xl text-sm text-secondary sm:text-base">
          Encuentra productos en las tiendas de UMANTAI. Compara precio y distancia, y compra en
          comercios cerca de ti.
        </p>
      </section>

      <DiscoveryHome initial={initial} />

      <div className="h-6" />
    </main>
  );
}
