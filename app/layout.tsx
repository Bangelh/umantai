import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Link from "next/link";
import { Toaster } from "sonner";
import { NavActions } from "./components/NavActions";
import { FloatingWhatsApp } from "./components/FloatingWhatsApp";
import { MobileBottomNav } from "./components/MobileBottomNav";
import { SiteFooter } from "./components/SiteFooter";
import { AuthLink } from "@/components/brand/AuthLink";
import { BrandLogo } from "@/components/brand/BrandLogo";
import { businessConfig } from "@/config/business";

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

const SITE_NAME = businessConfig.name;
const DEFAULT_TITLE = `${SITE_NAME} | Productos y comercios cerca de ti`;
const DEFAULT_DESCRIPTION =
  "Busca productos en las tiendas de UMANTAI: abarrotes, ropa, telas, ferretería y más. Precio, distancia y disponibilidad en una sola lista.";

/**
 * Metadata raíz.
 *
 * `title.template` permite que cada página defina solo su título
 * (`Contacto`, `Privacidad`…) y el layout agregue la marca.
 * `metadataBase` es obligatorio para que Open Graph y canonical resuelvan a
 * URLs absolutas.
 */
export const metadata: Metadata = {
  metadataBase: new URL(businessConfig.siteUrl),
  title: {
    default: DEFAULT_TITLE,
    template: `%s | ${SITE_NAME}`,
  },
  description: DEFAULT_DESCRIPTION,
  applicationName: SITE_NAME,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    locale: "es_PE",
    url: "/",
    siteName: SITE_NAME,
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true },
  },
  icons: {
    icon: "/favicon.ico",
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="es"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-primary">
        <a href="#contenido" className="skip-link">
          Saltar al contenido
        </a>

        {/* Top Navigation */}
        <nav aria-label="Principal" className="border-b border-border bg-background/80 backdrop-blur sticky top-0 z-50">
          <div className="max-w-7xl mx-auto px-5 sm:px-8 h-20 flex items-center justify-between gap-4">
            <Link href="/" className="shrink-0" aria-label="UMANTAI — inicio">
              <BrandLogo />
            </Link>
            <div className="flex items-center gap-2 sm:gap-4">
              <AuthLink />
              <NavActions />
            </div>
          </div>
        </nav>

        <div id="contenido" className="flex-1 pb-16 lg:pb-0">
          {children}
        </div>

        <SiteFooter />

        <MobileBottomNav />

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
