import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Link from "next/link";
import { cookies, headers } from "next/headers";
import { Toaster } from "sonner";
import { NavActions } from "./components/NavActions";
import { FloatingWhatsApp } from "./components/FloatingWhatsApp";
import { MobileBottomNav } from "./components/MobileBottomNav";
import { SiteFooter } from "./components/SiteFooter";
import { AuthLink } from "@/components/brand/AuthLink";
import { BrandLogo } from "@/components/brand/BrandLogo";
import { businessConfig, whatsappNumber } from "@/config/business";
import { I18nProvider } from "@/components/i18n/I18nProvider";
import { DEFAULT_LOCALE } from "@/lib/i18n/config";
import { getLocale, getMessages } from "@/lib/i18n/server";
import { createTranslator } from "@/lib/i18n";
import { isProductionRuntime } from "@/lib/runtime-environment.server";

/**
 * Staging/preview NUNCA se indexan: evita competir con Producción por las
 * mismas URLs y evita que un catálogo de prueba aparezca en buscadores.
 */
const INDEXABLE = isProductionRuntime();

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
    index: INDEXABLE,
    follow: INDEXABLE,
    googleBot: { index: INDEXABLE, follow: INDEXABLE },
  },
  icons: {
    icon: "/favicon.ico",
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  colorScheme: "dark light",
  width: "device-width",
  initialScale: 1,
};

/**
 * Aplica el tema antes del primer paint. Lee la cookie (accesible desde JS a
 * propósito) y cae a localStorage/sistema. Nunca interpola datos del usuario.
 */
const THEME_INIT_SCRIPT = `(function(){try{var m=document.cookie.match(/(?:^|; )umantai_theme=([^;]+)/);var stored=m?decodeURIComponent(m[1]):null;if(stored!=='light'&&stored!=='dark'&&stored!=='system'){stored=window.localStorage.getItem('umantai_theme')||'system';}var dark=window.matchMedia('(prefers-color-scheme: dark)').matches;var resolved=stored==='system'?(dark?'dark':'light'):stored;if(resolved!=='light'&&resolved!=='dark'){resolved='dark';}document.documentElement.dataset.theme=resolved;document.documentElement.style.colorScheme=resolved;}catch(e){}})();`;

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocale();
  const t = createTranslator(locale);
  const cookieStore = await cookies();
  // El nonce lo genera `proxy.ts` en cada request; el script de tema lo lleva
  // para que la CSP sin `'unsafe-inline'` lo permita.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  const preferredTheme = cookieStore.get('umantai_theme')?.value;
  const initialTheme =
    preferredTheme === 'light' || preferredTheme === 'dark' ? preferredTheme : 'dark';

  return (
    <html
      lang={locale}
      data-theme={initialTheme}
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col bg-background text-primary">
        <a href="#contenido" className="skip-link">
          {t('skip.link')}
        </a>

        <I18nProvider
          locale={locale}
          messages={getMessages(locale)}
          fallbackMessages={getMessages(DEFAULT_LOCALE)}
        >
          {/* Top Navigation */}
          <nav aria-label={t('nav.primary')} className="border-b border-border bg-background/80 backdrop-blur sticky top-0 z-50">
            <div className="max-w-7xl mx-auto px-5 sm:px-8 h-20 flex items-center justify-between gap-4">
              <Link href="/" className="shrink-0" aria-label={t('nav.homeAria')}>
                <BrandLogo />
              </Link>
              <div className="flex items-center gap-2 sm:gap-4">
                <AuthLink />
                <NavActions />
              </div>
            </div>
          </nav>

          {/* tabIndex -1: el enlace "Saltar al contenido" mueve el foco acá. */}
          <div id="contenido" tabIndex={-1} className="flex-1 outline-none">
            {children}
          </div>

          <SiteFooter />

          {/*
            La barra inferior es `fixed`: sin este espaciador se come el final del
            footer (los enlaces legales quedaban tapados en un celular). Va AL
            FINAL del documento, no como padding del contenido, para no abrir un
            hueco entre el contenido y el footer.
          */}
          <div aria-hidden="true" className="h-16 lg:hidden" />

          <MobileBottomNav />
        </I18nProvider>

        {/*
          Botón flotante de WhatsApp. El número viene de `config/business.ts`
          (override opcional por NEXT_PUBLIC_WHATSAPP_SALES_PHONE). Ventas y
          atención comparten el mismo canal, así que se muestra un solo botón.
          Los mensajes son opcionales:
          - NEXT_PUBLIC_WHATSAPP_SALES_MESSAGE
          - NEXT_PUBLIC_WHATSAPP_SUPPORT_MESSAGE
        */}
        <FloatingWhatsApp
          salesPhone={whatsappNumber()}
          supportPhone={whatsappNumber()}
          salesMessage={process.env.NEXT_PUBLIC_WHATSAPP_SALES_MESSAGE}
          supportMessage={process.env.NEXT_PUBLIC_WHATSAPP_SUPPORT_MESSAGE}
        />

        <Toaster position="top-center" richColors closeButton className="font-sans" />
      </body>
    </html>
  );
}
