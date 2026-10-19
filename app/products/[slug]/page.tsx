import { permanentRedirect } from 'next/navigation';

interface PageProps {
  params: Promise<{ slug: string }>;
}

/**
 * /products/<slug> — compatibilidad.
 *
 * Un slug legacy se traduce a una búsqueda por nombre en el buscador global.
 * No se conserva una ficha legacy separada: el detalle vive en
 * `/<store>/p/<product>`.
 */
export default async function LegacyProductPage({ params }: PageProps) {
  const { slug } = await params;
  const query = decodeURIComponent(slug).replace(/-+/g, ' ');
  permanentRedirect(`/?q=${encodeURIComponent(query)}`);
}
