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

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Vende tus productos en UMANTAI',
  description:
    'Publica tu catálogo, gestiona pedidos e inventario y aparece en el buscador local de UMANTAI.',
  alternates: { canonical: '/vender' },
};

export default async function SellPage() {
  const user = await getCurrentUser();

  return (
    <main className="mx-auto max-w-3xl px-4 pb-14 pt-6 sm:px-6">
      <p className="text-xs uppercase tracking-[2px] text-muted">Para negocios</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight sm:text-4xl">
        Vende tus productos en UMANTAI
      </h1>
      <p className="mt-2 max-w-2xl text-sm text-secondary sm:text-base">
        UMANTAI es un buscador local: cuando alguien busca “arroz”, “polo” o “tela” cerca de ti,
        tu tienda aparece con tus precios y disponibilidad.
      </p>

      <section aria-label="Qué incluye" className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { title: 'Catálogo', text: 'productos propios o del catálogo maestro' },
          { title: 'Pedidos', text: 'una cola por tienda, aislada' },
          { title: 'Inventario', text: 'stock real por SKU' },
          { title: 'Analytics', text: 'ventas y stock bajo' },
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
            Datos del negocio
          </h2>
          <MerchantOnboardingForm />
        </section>
      ) : (
        <section className="mt-8 rounded-2xl border border-border bg-surface p-5">
          <h2 className="text-lg font-semibold">Primero crea tu cuenta</h2>
          <p className="mt-1 text-sm text-secondary">
            Usa la misma identidad para comprar y para vender. No necesitas otra cuenta.
          </p>
          <Link
            href="/ingresar?next=/vender"
            className="mt-4 inline-flex h-11 items-center rounded-xl bg-brand px-5 text-sm font-semibold text-background"
          >
            Ingresar o crear cuenta
          </Link>
        </section>
      )}

      <section id="planes" className="mt-10 scroll-mt-24 rounded-2xl border border-border bg-surface p-5">
        <h2 className="text-lg font-semibold">Planes</h2>
        <p className="mt-1 text-sm text-secondary">
          En esta fase UMANTAI <strong>no cobra</strong> por publicar una tienda ni por recibir
          pedidos. No hay precios ni suscripciones definidos todavía: cuando el negocio los defina,
          el plan se asociará a cada Store y se mostrará acá.
        </p>
        <ul className="mt-3 space-y-1 text-sm text-tertiary">
          <li>· Alta sin costo durante el piloto.</li>
          <li>· Sin comisión configurada en esta etapa.</li>
          <li>· El pago en línea de Mercado Pago sigue congelado.</li>
        </ul>
      </section>

      <p className="mt-6 text-xs text-muted">
        Al enviar el formulario aceptas los{' '}
        <Link href="/legal/terminos" className="underline underline-offset-2 hover:text-primary">
          términos
        </Link>{' '}
        y la{' '}
        <Link href="/legal/privacidad" className="underline underline-offset-2 hover:text-primary">
          política de privacidad
        </Link>
        . La tienda se publica después de la revisión de UMANTAI.
      </p>
    </main>
  );
}
