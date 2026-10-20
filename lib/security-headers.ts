/**
 * lib/security-headers.ts — CSP por request (nonce).
 *
 * `script-src` ya NO usa `'unsafe-inline'`: Next adjunta el nonce a sus scripts
 * de framework y de página cuando la CSP llega en la request (lo hace `proxy.ts`).
 *
 * Excepciones conscientes:
 *   · `style-src 'unsafe-inline'`: Tailwind/Next inyectan atributos `style` en
 *     algunos componentes y el soporte de nonce para estilos no cubre
 *     `style="..."`. El riesgo es mucho menor que el de script y se documenta.
 *   · `'unsafe-eval'` SOLO en desarrollo (React lo usa para depuración).
 */

export interface CspOptions {
  nonce: string;
  isDev?: boolean;
}

export function buildContentSecurityPolicy({ nonce, isDev = false }: CspOptions): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "font-src 'self' data:",
    // Ver comentario de cabecera: los estilos inline siguen permitidos.
    "style-src 'self' 'unsafe-inline'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    isDev ? "connect-src 'self' https: wss: ws:" : "connect-src 'self' https: wss:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    isDev ? '' : 'upgrade-insecure-requests',
  ]
    .filter(Boolean)
    .join('; ');
}

/** Nonce impredecible por request (UUID → base64). */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
