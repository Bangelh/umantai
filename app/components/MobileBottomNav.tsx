"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, ShoppingBag, ShoppingCart } from "lucide-react";
import { useCartStore } from "@/lib/cartStore";
import { useHydrated } from "@/lib/useHydrated";
import { useI18n } from "@/components/i18n/I18nProvider";

export function MobileBottomNav() {
  const pathname = usePathname();
  // Stores persistidos en localStorage: los contadores esperan al montaje.
  const hydrated = useHydrated();
  const { t } = useI18n();
  const cartCount = useCartStore((s) => s.getTotalItems());

  // Sin pestaña de kiosco: la terminal de retiro es una pantalla operativa
  // (/admin/kiosco), no una sección del cliente.
  const tabs = [
    { href: "/", label: t('nav.home'), icon: Home },
    { href: "/#buscar", label: t('nav.shop'), icon: ShoppingBag },
    { href: "/cart", label: t('nav.cart'), icon: ShoppingCart },
  ];

  // Hide bottom nav for admin (desktop tools) and legacy kiosk route.
  if (pathname.startsWith("/kiosk") || pathname.startsWith("/admin")) {
    return null;
  }

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  };

  const getCount = (href: string) => (href === "/cart" ? cartCount : 0);

  return (
    <nav
      aria-label={t('nav.bottom')}
      className="lg:hidden fixed bottom-0 left-0 right-0 z-[60] border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 pb-[env(safe-area-inset-bottom)]"
    >
      <div className="max-w-7xl mx-auto px-2">
        <div className="flex items-center justify-around h-16">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const active = isActive(tab.href);
            const count = getCount(tab.href);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={`flex min-h-12 flex-col items-center justify-center flex-1 gap-0.5 py-1 text-[11px] transition-colors ${active ? "text-primary font-semibold" : "text-tertiary hover:text-secondary"}`}
              >
                <div className="relative">
                  <Icon className="h-6 w-6" aria-hidden="true" />
                  {hydrated && count > 0 && (
                    <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-1 rounded-full bg-brand text-[9px] font-medium text-background flex items-center justify-center tabular-nums">
                      {count > 99 ? "99+" : count}
                    </span>
                  )}
                </div>
                <span className="mt-0.5 tracking-tight">{tab.label}</span>
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
