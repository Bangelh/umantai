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
        className="wa-float"
        aria-label="Contact us via WhatsApp"
      >
        <img
          src="https://upload.wikimedia.org/wikipedia/commons/6/6b/WhatsApp.svg"
          alt="WhatsApp"
          width={52}
          height={52}
          style={{ borderRadius: "50%", display: "block" }}
        />
      </button>
    </div>
  );
}
