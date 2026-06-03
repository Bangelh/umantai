"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, ShoppingBag, ListTodo, ShoppingCart, Monitor } from "lucide-react";
import { useCartStore } from "@/lib/cartStore";
import { useShoppingListStore } from "@/lib/shoppingListStore";

const tabs = [
  { href: "/", label: "Home", icon: Home },
  { href: "/products", label: "Shop", icon: ShoppingBag },
  { href: "/list", label: "List", icon: ListTodo },
  { href: "/cart", label: "Cart", icon: ShoppingCart },
  { href: "/kiosk", label: "Kiosk", icon: Monitor },
];

export function MobileBottomNav() {
  const pathname = usePathname();
  const cartCount = useCartStore((s) => s.getTotalItems());
  const listCount = useShoppingListStore((s) => s.getTotalItems());

  // Hide bottom nav for kiosk (full immersive) and admin (desktop tools)
  if (pathname.startsWith("/kiosk") || pathname.startsWith("/admin")) {
    return null;
  }

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  };

  const getCount = (label: string) => {
    if (label === "Cart") return cartCount;
    if (label === "List") return listCount;
    return 0;
  };

  return (
    <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-[60] border-t border-white/10 bg-neutral-950/95 backdrop-blur supports-[backdrop-filter]:bg-neutral-950/80 pb-[env(safe-area-inset-bottom)]">
      <div className="max-w-7xl mx-auto px-2">
        <div className="flex items-center justify-around h-14">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const active = isActive(tab.href);
            const count = getCount(tab.label);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={`flex flex-col items-center justify-center flex-1 py-1 text-[10px] transition-colors ${active ? "text-white" : "text-white/50 hover:text-white/80"}`}
              >
                <div className="relative">
                  <Icon className="h-5 w-5" />
                  {count > 0 && (
                    <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-1 rounded-full bg-white text-[9px] font-medium text-black flex items-center justify-center tabular-nums">
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
