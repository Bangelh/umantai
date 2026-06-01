"use client";

import React, { useState } from "react";
import { usePathname } from "next/navigation";

// Environment variables
const SALES_PHONE = process.env.NEXT_PUBLIC_WHATSAPP_SALES_PHONE || "15551234567";
const SUPPORT_PHONE = process.env.NEXT_PUBLIC_WHATSAPP_SUPPORT_PHONE || "15551234567";

const SALES_MESSAGE = process.env.NEXT_PUBLIC_WHATSAPP_SALES_MESSAGE || 
  "Hello! I'd like to know more about your products.";
  
const SUPPORT_MESSAGE = process.env.NEXT_PUBLIC_WHATSAPP_SUPPORT_MESSAGE || 
  "Hello! I need some help with my order / account.";

interface FloatingWhatsAppProps {
  salesPhone?: string;
  supportPhone?: string;
}

export function FloatingWhatsApp({ 
  salesPhone, 
  supportPhone 
}: FloatingWhatsAppProps) {
  
  const [isOpen, setIsOpen] = useState(false);
  const pathname = usePathname();

  const salesNumber = salesPhone || SALES_PHONE;
  const supportNumber = supportPhone || SUPPORT_PHONE;

  // Generate contextual message based on current page
  const getContextualMessage = (baseMessage: string): string => {
    if (pathname?.startsWith("/products/")) {
      const slug = pathname.split("/products/")[1];
      if (slug) {
        const productName = slug
          .split("-")
          .map(word => word.charAt(0).toUpperCase() + word.slice(1))
          .join(" ");
        return `Hello! I'm interested in the ${productName}.`;
      }
    }
    if (pathname === "/kiosk") {
      return "Hello! I'd like more information about the Ready for Pickup Kiosk.";
    }
    return baseMessage;
  };

  const salesMessage = getContextualMessage(SALES_MESSAGE);
  const supportMessage = getContextualMessage(SUPPORT_MESSAGE);

  const salesUrl = `https://wa.me/${salesNumber}?text=${encodeURIComponent(salesMessage)}`;
  const supportUrl = `https://wa.me/${supportNumber}?text=${encodeURIComponent(supportMessage)}`;

  const toggleMenu = () => setIsOpen(!isOpen);

  return (
    <div className="fixed bottom-6 right-6 z-[999999] flex flex-col items-end gap-2">
      {/* Options Menu */}
      {isOpen && (
        <div className="flex flex-col gap-2 mb-2">
          {/* Sales Button */}
          <a
            href={salesUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 bg-[#25D366] text-white px-4 py-2.5 rounded-full shadow-lg hover:bg-[#1da851] transition-all"
            onClick={() => setIsOpen(false)}
          >
            <span className="text-sm font-medium">💬 Sales</span>
          </a>

          {/* Support Button */}
          <a
            href={supportUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 bg-[#0088CC] text-white px-4 py-2.5 rounded-full shadow-lg hover:bg-[#0077b3] transition-all"
            onClick={() => setIsOpen(false)}
          >
            <span className="text-sm font-medium">🛠 Support</span>
          </a>
        </div>
      )}

      {/* Main Floating Button */}
      <button
        onClick={toggleMenu}
        className="wa-float flex h-[56px] w-[56px] items-center justify-center rounded-full bg-[#25D366] shadow-xl transition-all hover:scale-105 hover:bg-[#20bd5a] active:scale-95"
        aria-label="Contact us via WhatsApp"
      >
        {/* Local WhatsApp icon (inline SVG for reliability & no external requests) */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="30"
          height="30"
          viewBox="0 0 24 24"
          fill="white"
          aria-hidden="true"
        >
          <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.198-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.372-.025-.521-.075-.149-.67-1.612-.92-2.206-.247-.593-.5-.51-.67-.51-.172 0-.37-.01-.567-.01-.197 0-.52.074-.793.372-.272.298-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z" />
          <path d="M12 2C6.477 2 2 6.477 2 12c0 1.89.525 3.66 1.438 5.168L2 22l4.832-1.438A9.96 9.96 0 0012 22c5.523 0 10-4.477 10-10S17.523 2 12 2zm0 18c-1.476 0-2.886-.4-4.1-1.1l-.3-.2-2.9.85.85-2.85-.2-.3A7.96 7.96 0 014 12c0-4.411 3.589-8 8-8s8 3.589 8 8-3.589 8-8 8z" />
        </svg>
      </button>
    </div>
  );
}
