/**
 * proxy.ts — guardia de origen (CSRF) para las rutas de API.
 *
 * Next 16 renombró `middleware.ts` a `proxy.ts`. Solo se ejecuta en `/api/*`:
 * las páginas no pagan este costo.
 *
 * Regla:
 *   · métodos seguros (GET/HEAD/OPTIONS) pasan;
 *   · webhooks de pago, cron y Payload quedan fuera (tienen su propia firma);
 *   · si el navegador manda `Origin`, debe coincidir con el host de la request
 *     o con un origen configurado;
 *   · si `Sec-Fetch-Site` dice `cross-site`, se rechaza aunque no haya Origin.
 *
 * No sustituye la autorización: solo impide que un sitio ajeno use la cookie
 * del usuario para mutar datos.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { buildContentSecurityPolicy, createNonce } from './lib/security-headers';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const EXEMPT_PREFIXES = [
  '/api/payments/webhook',
  '/api/mp-orders/webhook',
  '/api/payload',
  '/api/cron/',
];

function trustedOrigins(request: NextRequest): Set<string> {
  const origins = new Set<string>([request.nextUrl.origin]);

  const forwardedHost = request.headers.get('x-forwarded-host');
  const forwardedProto = request.headers.get('x-forwarded-proto');
  if (forwardedHost) {
    origins.add(`${forwardedProto ?? 'https'}://${forwardedHost}`);
  }

  for (const value of [
    process.env.NEXT_PUBLIC_SERVER_URL,
    process.env.NEXT_PUBLIC_SITE_URL,
    process.env.BETTER_AUTH_URL,
    process.env.RAILWAY_PUBLIC_DOMAIN,
  ]) {
    if (!value) continue;
    const normalized = value.startsWith('http')
      ? value.replace(/\/+$/, '')
      : `https://${value.replace(/\/+$/, '')}`;
    try {
      origins.add(new URL(normalized).origin);
    } catch {
      // Variable malformada: se ignora.
    }
  }

  if (process.env.NODE_ENV !== 'production') {
    origins.add('http://localhost:3000');
    origins.add('http://127.0.0.1:3000');
  }

  return origins;
}

function isExempt(pathname: string): boolean {
  return EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const requestId = crypto.randomUUID();
  const nonce = createNonce();
  const csp = buildContentSecurityPolicy({
    nonce,
    isDev: process.env.NODE_ENV !== 'production',
  });

  if (MUTATING.has(request.method) && !isExempt(pathname)) {
    const origin = request.headers.get('origin');
    const fetchSite = request.headers.get('sec-fetch-site');

    if (fetchSite === 'cross-site') {
      return NextResponse.json(
        { ok: false, code: 'csrf_origin_rejected', error: 'Origen no permitido.' },
        { status: 403, headers: { 'x-request-id': requestId, 'cache-control': 'no-store' } },
      );
    }

    if (origin) {
      let normalized: string | null = null;
      try {
        normalized = new URL(origin).origin;
      } catch {
        normalized = null;
      }
      if (!normalized || !trustedOrigins(request).has(normalized)) {
        return NextResponse.json(
          { ok: false, code: 'csrf_origin_rejected', error: 'Origen no permitido.' },
          { status: 403, headers: { 'x-request-id': requestId, 'cache-control': 'no-store' } },
        );
      }
    }
  }

  const headers = new Headers(request.headers);
  headers.set('x-request-id', requestId);
  headers.set('x-nonce', nonce);
  // Next lee esta cabecera de la REQUEST y adjunta el nonce a sus scripts.
  headers.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set('x-request-id', requestId);
  response.headers.set('x-nonce', nonce);
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

/**
 * Se ejecuta en páginas y APIs, pero no en assets estáticos ni prefetches: esos
 * no renderizan HTML y no necesitan un nonce nuevo. Las páginas son dinámicas
 * porque el layout raíz ya lee cookies (`getLocale`).
 */
export const config = {
  matcher: [
    {
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
