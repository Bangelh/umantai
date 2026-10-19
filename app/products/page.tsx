import { permanentRedirect } from 'next/navigation';

/**
 * /products — compatibilidad.
 *
 * La experiencia pública es una sola: `/` (buscador global), `/<store>`
 * (vitrina) y `/<store>/p/<slug>` (detalle). Se mantiene la URL con un 308 para
 * no romper enlaces existentes, pero ya no hay un segundo catálogo contradictorio.
 */
export default function LegacyProductsPage() {
  permanentRedirect('/');
}
