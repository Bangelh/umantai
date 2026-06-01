import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Link from "next/link";
import { Toaster } from "sonner";
import { NavActions } from "./components/NavActions";
import { FloatingWhatsApp } from "./components/FloatingWhatsApp";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Umantai | Premium Whole Foods & Technology",
  description: "A modern omnichannel retailer. Shop exceptional whole foods, premium tech, and accessories. Experience our signature Ready for Pickup kiosk or enjoy white-glove delivery.",
  icons: {
    icon: "/favicon.ico",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-neutral-950 text-neutral-100">
        {/* Top Navigation */}
        <nav className="border-b border-white/10 bg-neutral-950/80 backdrop-blur sticky top-0 z-50">
          <div className="max-w-7xl mx-auto px-8 h-20 flex items-center justify-between">
            <Link href="/" className="font-semibold text-2xl tracking-[-1px]">
              umantai
            </Link>
            <NavActions />
          </div>
        </nav>

        {children}

        {/* 
          Floating WhatsApp button with Sales & Support options.
          Configure via environment variables:
          - NEXT_PUBLIC_WHATSAPP_SALES_PHONE
          - NEXT_PUBLIC_WHATSAPP_SUPPORT_PHONE
          
          Optional:
          - NEXT_PUBLIC_WHATSAPP_SALES_MESSAGE
          - NEXT_PUBLIC_WHATSAPP_SUPPORT_MESSAGE
        */}
        <FloatingWhatsApp />

        <Toaster position="top-center" richColors closeButton className="font-sans" />
      </body>
    </html>
  );
}
