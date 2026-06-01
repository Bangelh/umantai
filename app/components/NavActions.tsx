"use client";

import Link from "next/link";
import { useCartStore } from "@/lib/cartStore";
import { useShoppingListStore } from "@/lib/shoppingListStore";

export function NavActions() {
  const cartCount = useCartStore((state) => state.getTotalItems());
  const listCount = useShoppingListStore((state) => state.getTotalItems());

  return (
    <div className="flex items-center gap-4">
      <Link href="/kiosk">
        <button className="px-4 py-1.5 text-sm rounded-full border border-white/20 hover:bg-white/5 transition-colors">
          Ready for Pickup Kiosk
        </button>
      </Link>

      <Link href="/list">
        <button className="relative px-4 py-1.5 text-sm rounded-full border border-white/20 hover:bg-white/5 transition-colors flex items-center gap-2">
          Shopping List
          {listCount > 0 && (
            <span className="flex items-center justify-center min-w-[18px] h-[18px] px-1.5 text-[10px] font-medium bg-white text-black rounded-full">
              {listCount}
            </span>
          )}
        </button>
      </Link>

      <Link href="/cart">
        <button className="relative px-4 py-1.5 text-sm rounded-full bg-white text-black font-medium hover:bg-white/90 transition-colors flex items-center gap-2">
          View Cart
          {cartCount > 0 && (
            <span className="flex items-center justify-center min-w-[18px] h-[18px] px-1.5 text-[10px] font-medium bg-neutral-800 text-white rounded-full">
              {cartCount}
            </span>
          )}
        </button>
      </Link>
    </div>
  );
}
