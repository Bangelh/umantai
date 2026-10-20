"use client";

import Link from "next/link";
import { useCartStore } from "@/lib/cartStore";
import { useShoppingListStore } from "@/lib/shoppingListStore";
import { useHydrated } from "@/lib/useHydrated";
import { useI18n } from "@/components/i18n/I18nProvider";

/**
 * Acciones del header.
 *
 * Antes cada acción era `<Link><button>`, un control interactivo dentro de otro
 * (HTML inválido y confuso para teclado/lectores). Ahora el `<Link>` ES el botón.
 *
 * En móvil el header deja solo el carrito: la navegación inferior
 * (`MobileBottomNav`) ya cubre kiosco y lista, y tres pastillas no entran en
 * 320 px.
 */
export function NavActions() {
  // Ambos stores se persisten en localStorage: sus contadores no se pueden pintar
  // hasta después del montaje (ver `lib/useHydrated.ts`).
  const hydrated = useHydrated();
  const { t } = useI18n();
  const cartCount = useCartStore((state) => state.getTotalItems());
  const listCount = useShoppingListStore((state) => state.getTotalItems());

  return (
    <div className="flex items-center gap-2 sm:gap-4">
      <Link
        href="/kiosk"
        className="hidden md:inline-flex items-center rounded-full border border-border-strong px-4 py-1.5 text-sm text-primary transition-colors hover:bg-surface-raised"
      >
        {t('nav.readyPickup')}
      </Link>

      <Link
        href="/list"
        className="hidden sm:inline-flex items-center gap-2 rounded-full border border-border-strong px-4 py-1.5 text-sm text-primary transition-colors hover:bg-surface-raised"
        aria-label={
          hydrated && listCount > 0
            ? t('nav.listAriaCount', { count: listCount })
            : t('nav.listAria')
        }
      >
        {t('nav.shoppingList')}
        {hydrated && listCount > 0 && (
          <span
            aria-hidden="true"
            className="flex items-center justify-center min-w-[18px] h-[18px] px-1.5 text-[10px] font-medium bg-brand text-background rounded-full"
          >
            {listCount}
          </span>
        )}
      </Link>

      <Link
        href="/cart"
        className="inline-flex items-center gap-2 rounded-full bg-brand px-4 py-1.5 text-sm font-medium text-background transition-opacity hover:opacity-90"
        aria-label={
          hydrated && cartCount > 0
            ? t('nav.cartAriaCount', { count: cartCount })
            : t('nav.cartAria')
        }
      >
        <span aria-hidden="true">{t('nav.cart')}</span>
        {hydrated && cartCount > 0 && (
          <span
            aria-hidden="true"
            className="flex items-center justify-center min-w-[18px] h-[18px] px-1.5 text-[10px] font-medium bg-background text-primary rounded-full"
          >
            {cartCount}
          </span>
        )}
      </Link>
    </div>
  );
}
