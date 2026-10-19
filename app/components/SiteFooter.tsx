import Link from 'next/link';

import { businessConfig } from '@/config/business';
import { HELP_NAV_LINKS, LEGAL_NAV_LINKS, SHOP_NAV_LINKS } from '@/lib/navigation';

/**
 * Footer global. Server Component: no manda JS al cliente.
 * `print:hidden` evita que aparezca en la lista de compras impresa.
 */
export function SiteFooter() {
  return (
    <footer className="print:hidden mt-auto border-t border-border bg-surface/40">
      <div className="mx-auto max-w-7xl px-5 py-10 sm:px-8">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <div className="text-lg font-semibold tracking-tight">{businessConfig.name}</div>
            <p className="mt-2 max-w-xs text-sm leading-relaxed text-tertiary">
              Alimentos y tecnología seleccionados, con retiro en tienda y entrega coordinada.
            </p>
          </div>

          <nav aria-label="Tienda">
            <h2 className="text-xs uppercase tracking-wide text-tertiary">Tienda</h2>
            <ul className="mt-3 space-y-2 text-sm">
              {SHOP_NAV_LINKS.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="text-secondary hover:text-primary">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <nav aria-label="Ayuda">
            <h2 className="text-xs uppercase tracking-wide text-tertiary">Ayuda</h2>
            <ul className="mt-3 space-y-2 text-sm">
              {HELP_NAV_LINKS.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="text-secondary hover:text-primary">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <nav aria-label="Legal">
            <h2 className="text-xs uppercase tracking-wide text-tertiary">Legal</h2>
            <ul className="mt-3 space-y-2 text-sm">
              {LEGAL_NAV_LINKS.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="text-secondary hover:text-primary">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        <div className="mt-8 flex flex-col gap-2 border-t border-border pt-6 text-xs text-muted sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {new Date().getFullYear()} {businessConfig.name}. Todos los derechos reservados.
          </p>
          <p>
            Documentos legales en borrador, pendientes de validación del negocio.
          </p>
        </div>
      </div>
    </footer>
  );
}
