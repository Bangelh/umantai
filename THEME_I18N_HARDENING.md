# THEME + I18N + HARDENING — estado de la fase

**Fecha:** 2026-10-20 · **Rama:** `feat/railway-staging` · **Staging:** `https://web-staging-6756.up.railway.app`
**Producción, DNS y Mercado Pago de pedidos:** intactos.

---

## 1. Tema claro / oscuro / sistema

- Preferencia en `localStorage.umantai_theme` y cookie legible `umantai_theme`.
- `app/layout.tsx` inyecta un script mínimo en `<head>` que fija `data-theme`
  **antes del primer paint** (evita flash). El `<html>` lleva `suppressHydrationWarning`.
- `components/theme/ThemeToggle.tsx` cicla claro → oscuro → sistema y escucha
  `prefers-color-scheme` cuando el modo es sistema.
- Los tokens viven en `app/globals.css`; `[data-theme="light"]` los sobrescribe.
  `color-scheme` acompaña para que los controles nativos se vean bien.
- Puente temporal: utilidades legacy (`text-white/60`, `bg-neutral-950`, etc.) se
  remapean a tokens en claro. Deuda: migrarlas a `text-secondary`/`bg-surface`
  y borrar ese bloque.
- Accesibilidad: salto al contenido existente, foco visible, `aria-label` en el
  toggle, `prefers-reduced-motion` global y `lang` correcto.

## 2. Internacionalización es/en

- Locale en cookie `umantai_locale` (sin prefijo de ruta, sin reescribir URLs).
- `lib/i18n/dictionaries.ts`: claves planas, español default y fallback.
- `lib/i18n/server.ts` para Server Components; `components/i18n/I18nProvider.tsx`
  para cliente. Solo se envía al navegador el diccionario activo.
- Interpolación `{variable}` sin evaluar HTML. `tests/i18n.test.ts` exige paridad
  exacta de claves y que ninguna esté vacía.
- **Cubierto:** navegación superior e inferior, footer, login/registro, vitrina de
  tienda, búsqueda dentro de tienda, estados vacíos y “Plan y facturación”.
- **No traducido aún:** buscador global/home, carrito (heredado en inglés),
  paneles de catálogo/inventario/analytics y mensajes de validación de esas
  pantallas. El contenido de las tiendas (nombres, productos, descripciones,
  direcciones, categorías propias) **nunca** se traduce.
- Cómo agregar una clave: añadir a `es` y `en`, usar `t('clave')`; el test falla
  si falta en un idioma.

## 3. Hardening implementado

| Área | Control |
|---|---|
| Platform Admin | Login Better Auth + rol en `platform_admins` (o `PLATFORM_ADMIN_EMAILS`) + cookie HMAC `umantai_platform_admin` (HttpOnly, Strict, Secure en prod, 8 h). El token compartido queda como respaldo de desarrollo; en Producción exige sesión salvo `ALLOW_ADMIN_TOKEN_FALLBACK=1`. |
| CSRF / origen | `proxy.ts` rechaza mutaciones `/api/*` con `Origin` ajeno o `Sec-Fetch-Site: cross-site`. Exentos: webhooks de pago, cron y Payload (firma propia). |
| Headers | CSP, HSTS, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP y CORP. `poweredByHeader` desactivado. |
| Rate limiting | Login/registro 15/min por IP; demás auth 90/min; uploads 10/min por usuario (merchant) y 20/min por IP (admin). En memoria por instancia. |
| Uploads | MIME por magic bytes, 2 MB, key UUID, sin nombre original, solo JPG/PNG/WebP, archivos archivados no se sirven, cache inmutable y rate limit. |
| Aislamiento | Trigger `media_assets_tenant_scope` (020): un asset no puede apuntar a un producto de otra tienda ni quedar sin tienda. |
| Observabilidad | `lib/observability.server.ts` emite una línea JSON por evento (`admin_unauthorized`, `auth_rate_limited`, `admin_token_fallback_used`, `auth_request_failed`) con `x-request-id` inyectado por `proxy.ts`. Sin secretos ni cuerpos. |
| Legal | Privacidad: cuenta, suscripciones, imágenes, preferencias y sesión de admin. Términos: planes USD, renovación, cancelación, downgrade y códigos +1 mes. Sigue siendo **borrador** pendiente de validación legal. |
| Accesibilidad | `lang`, skip link, foco visible, labels/aria en controles nuevos, reduced motion, contraste por tokens. |
| Performance | `optimizePackageImports: ['lucide-react']`, cache inmutable de media, carga medida en staging (abajo). |

### RLS: por qué no se activó

La aplicación usa **un único rol dueño del schema** (`DATABASE_URL`). Activar RLS
sin separar roles y sin `SET LOCAL app.current_user` en cada transacción
rompería la app y daría una falsa sensación de aislamiento. La segunda barrera
se implementó con el trigger de tenant; la deuda es crear un rol no-owner,
inyectar el usuario en la transacción y migrar las policies tabla por tabla.

### Bootstrap de Platform Admin

1. Aplicar migración `019_platform_admins.sql`.
2. Registrar el usuario (Better Auth) o usar uno existente.
3. `npm run admin:grant -- correo@dominio` (o `PLATFORM_ADMIN_EMAILS` temporal).
4. En `/admin/planes`, “Activar sesión de administrador” canjea la sesión por la
   cookie firmada. `DELETE /api/admin/session` la revoca.

## 4. Verificación (2026-10-20)

- `npx tsc --noEmit` → 0 errores.
- `npm test` → **398/398**.
- `npm run test:integration` (PostgreSQL real, 001–020) → **85/85**.
- `npm run build` → OK (con `PAYLOAD_SECRET` de build).
- `scripts/security-smoke.mjs --load 30` → **12/12**, CSRF 403, admin/uploads 401,
  429 en login, carga 30 req `p50=351 ms`, `p95=2385 ms`, 0 errores.
- `npx playwright test` → **6/6** (headers, tema, idioma, tienda, CSRF, gate admin).
- Platform Admin real en staging: sesión Better Auth → cookie firmada → 
  `GET /api/admin/plans` 200 con 3 planes; sin cookie 401; cookie falsificada 401.
- Logs de staging muestran `admin_unauthorized` con `requestId`.
- Smoke previo del cron conjunto: reservas + billing 200, exit 0.

## 5. Deuda y riesgos

1. **CSP con `'unsafe-inline'`** en `script-src`: Next inyecta bootstrap inline.
   Migrar a nonce por request (proxy + `x-nonce`) antes de endurecer más.
2. **Rate limit en memoria**: con varias réplicas cada una lleva su cuenta.
   Reemplazar por un store compartido (Redis/KV) si se escala.
3. **RLS** pendiente (ver arriba).
4. **i18n parcial**: faltan home/buscador global, carrito y paneles internos.
   El carrito heredado está en inglés incluso con locale `es`.
5. **Paneles `/admin` legacy** siguen pidiendo el token en la UI aunque la API ya
   acepta la cookie de sesión. Migrarlos antes de desactivar el fallback.
6. **Playwright**: el navegador Chromium se instala aparte
   (`npm run e2e:install`); el primer intento puede tardar varios minutos.
7. **Legal** sigue en borrador; falta revisión profesional.
8. **Producción**: no se desplegó ni se cambiaron variables/DNS. Antes del
   cutover hay que crear el primer Platform Admin y definir
   `PLATFORM_ADMIN_SECRET`.
