import type { Metadata } from 'next';

import { businessConfig } from '@/config/business';

export const metadata: Metadata = {
  title: 'Productos',
  description:
    'Explora el catálogo de alimentos y tecnología de Umantai. Precios en soles, disponibilidad real y retiro en tienda.',
  alternates: { canonical: `${businessConfig.siteUrl}/products` },
  openGraph: {
    type: 'website',
    title: `Productos | ${businessConfig.name}`,
    description: 'Catálogo con disponibilidad real y retiro en tienda.',
    url: `${businessConfig.siteUrl}/products`,
    siteName: businessConfig.name,
  },
};

export default function ProductsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
