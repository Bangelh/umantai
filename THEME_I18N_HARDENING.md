# THEME + I18N + HARDENING — estado de la fase

**Fecha:** 2026-10-20 · **Rama:** `feat/railway-staging` · **Staging:** `https://web-staging-6756.up.railway.app`
**Producción, DNS, `main` y Mercado Pago de pedidos:** intactos.

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
- Accesibilidad: salto al contenido, foco visible, `aria-label` en el toggle,
  `prefers-reduced-motion` global y `lang` correcto.

## 2. Internacionalización es/en

- Locale en cookie `umantai_locale` (sin prefijo de ruta, sin reescribir URLs).
- `lib/i18n/dictionaries.ts`: claves planas, español default y fallback.
- `lib/i18n/server.ts` para Server Components; `components/i18n/I18nProvider.tsx`
  para cliente. Solo se envía al navegador el diccionario activo.
- Interpolación `{variable}` sin evaluar HTML. `tests/i18n.test.ts` exige paridad
  exacta de claves y que ninguna esté vacía.
- **Cubierto:** navegación superior e inferior, footer, login/registro,
  recuperación/restablecimiento, cuenta y seguridad, vitrina de tienda,
  buscador global y home, geolocalización manual, carrito y checkout, alta de
  tienda, paneles de catálogo/inventario/analytics/planes y kiosco.
- El contenido de las tiendas (nombres, productos, descripciones, direcciones,
  categorías propias) **nunca** se traduce.
- Cómo agregar una clave: añadir a `es` y `en`, usar `t('clave')`; el test falla
  si falta en un idioma.

## 3. Hardening implementado

| Área | Control |
|---|---|
| Platform Admin | Login Better Auth + rol en `platform_admins` (o `PLATFORM_ADMIN_EMAILS`) + cookie HMAC `umantai_platform_admin` (HttpOnly, Strict, Secure en prod, 8 h). La UI humana **nunca** pide `ADMIN_API_SECRET`: usa `usePlatformAdminSession` + `AdminAccessScreen`. El token compartido queda solo para automatización; en Producción exige sesión salvo `ALLOW_ADMIN_TOKEN_FALLBACK=1`. |
| `/debug` | `/debug/env` ya no tiene formulario de token y `/debug/supabase` (demo público) se eliminó. `app/debug/layout.tsx` exige cookie de Platform Admin; sin ella responde **404**. `/api/debug/env` sigue exigiendo la misma sesión (401 sin cookie). |
| CSRF / origen | `proxy.ts` rechaza mutaciones `/api/*` con `Origin` ajeno o `Sec-Fetch-Site: cross-site`. Exentos: webhooks de pago, cron y Payload (firma propia). |
| CSP | Nonce único por request en `proxy.ts`; `script-src 'self' 'nonce-…' 'strict-dynamic'` **sin `'unsafe-inline'`**. El script de tema usa el nonce. `style-src` conserva `'unsafe-inline'` (Tailwind/Next) y `'unsafe-eval'` solo en desarrollo. |
| Rate limiting | Una sola capa por request (`lib/rate-limit.server.ts` + `rateLimitGate`) con backend sustituible (`setRateLimitProvider`) y fail-closed si el distribuido falla. Login/registro 15/min; recuperación 5/min; resto auth 90/min; uploads 10/min por usuario y 20/min por IP. `AUTH_TEST_MODE` sube el cupo (120/30) para el E2E; nunca aplica en Producción. Se desactivó el limiter interno de Better Auth y la barrera síncrona duplicada (contaban cada intento dos veces). |
| Auth lifecycle | Registro → verificación (outbox test-mode) → logout/login → recuperación (`/api/auth/request-password-reset`, antes apuntaba a un endpoint inexistente) → cambio de contraseña → revocación de otras sesiones. |
| Uploads | MIME por magic bytes, 2 MB, key UUID, sin nombre original, solo JPG/PNG/WebP, archivos archivados no se sirven, cache inmutable y rate limit. |
| Aislamiento | Trigger `media_assets_tenant_scope` (020) + `requireStoreAccess` en cada operación. Migración **022** habilita RLS real en `store_products`, `product_variants`, `inventory`, `inventory_movements`, `orders`, `order_items`, `store_subscriptions` y `promotion_redemptions`, con rol `umantai_tenant` (NOBYPASSRLS) y policies por `app.store_id`. La app sigue con el rol dueño (no se fuerza RLS); `tests/rls.integration.test.ts` prueba las policies con el rol tenant. Deuda: migrar la app a ese rol e inyectar `app.store_id` por transacción. |
| Observabilidad | `lib/observability.server.ts` emite una línea JSON por evento (`admin_unauthorized`, `rate_limited`, `auth_rate_limited`, `auth_request_failed`) con `x-request-id` inyectado por `proxy.ts`. Sin secretos ni cuerpos. |
| Legal | Privacidad: cuenta, suscripciones, imágenes, preferencias y sesión de admin. Términos: planes USD, renovación, cancelación, downgrade y códigos +1 mes. Sigue siendo **borrador** pendiente de validación legal. |
| Performance | `optimizePackageImports: ['lucide-react']`, cache inmutable de media, baseline de carga reproducible (abajo). |
| Operación | `scripts/cleanup-smoke-data.ts` borra solo datos etiquetados (`@umantai.test`, `e2e-*`, `smoke-*`), dry-run por defecto, transacción única y gate `APP_ENV=staging|test`. Orden corregido: `inventory` antes de `stores` por la FK RESTRICT. |

### Bootstrap de Platform Admin

1. Aplicar migración `019_platform_admins.sql`.
2. Registrar el usuario (Better Auth) o usar uno existente.
3. `npm run admin:grant -- correo@dominio` (o `PLATFORM_ADMIN_EMAILS` temporal).
4. En `/admin/planes`, “Activar sesión de administrador” canjea la sesión por la
   cookie firmada. `DELETE /api/admin/session` la revoca.

## 4. Verificación (2026-10-20, local con PostgreSQL efímero + seed real)

- `npx tsc --noEmit` → 0 errores.
- `npm test` → **415/415**.
- `npm run test:integration` (PostgreSQL 17 real, migraciones 001–022) → **94/94**.
- `npm run build` → OK (con `PAYLOAD_SECRET` de build).
- `npx playwright test` contra `next start` local → **52 passed, 1 skipped**
  (`E2E_ADMIN_EMAIL` no configurado). Incluye auth lifecycle completo,
  comercio/checkout, merchant multi-tienda, aislamiento entre cuentas, admin sin
  token, responsive 390/768/1440 y headers/CSP.
- `node scripts/security-smoke.mjs` → **22/22** (CSRF 403, admin 401, debug 401,
  upload 401, JSON 400, payload 413/429, XSS no reflejado, rate limit 429).
- `node scripts/load-baseline.mjs --requests=20 --concurrency=5` → 0 errores;
  p50 5–35 ms, p95 6–110 ms en local. Con 40 peticiones el endpoint de búsqueda
  geo supera su límite por IP y devuelve 429 (esperado; usar ≤20 para medir).
- `scripts/cleanup-smoke-data.ts` → dry-run y `--confirm` borran exactamente los
  datos etiquetados y dejan el resto intacto (verificado: 0 restantes).
- `/api/cron/expire-reservations` y `/api/cron/billing` → **401** sin secreto,
  **200** con `CRON_SECRET`.
- `/debug/env` → **404** sin cookie, **200** con cookie de Platform Admin válida;
  `/api/debug/env` → **401** sin cookie.

### Staging

- El último commit desplegado en staging sigue siendo `478e173` (health lo
  confirma). Los intentos de `railway up` de esta fase responden
  **“Deploys have been paused temporarily”**: Railway tiene los deploys del
  proyecto pausados. No es un fallo de la app y no se puede resolver desde el
  repositorio; requiere reactivar/pagar el proyecto en Railway.
- Por eso la verificación E2E/seguridad/carga de arriba se ejecutó contra el
  artefacto local (`next start`) con PostgreSQL real y datos sembrados, no
  contra staging. En cuanto se reanuden los deploys hay que repetir:
  `node scripts/security-smoke.mjs`, `node scripts/load-baseline.mjs
  --requests=20` y `npx playwright test` contra `https://web-staging-…`.

## 5. Deuda y riesgos

1. **Deploy de staging pausado en Railway** (bloqueante externo). Sin eso no se
   puede cerrar el QA final sobre el artefacto desplegado.
2. **Rate limit en memoria**: con varias réplicas cada una lleva su cuenta.
   El provider distribuido ya existe como interfaz; falta implementarlo
   (Redis/KV) y registrarlo con `setRateLimitProvider`.
3. **RLS**: policies y rol tenant listos y probados, pero la app sigue usando el
   rol dueño. Migrar las transacciones a `umantai_tenant` + `app.store_id`.
4. **`style-src 'unsafe-inline'`** se mantiene por Tailwind/Next; el riesgo de
   estilo es mucho menor que el de script.
5. **Paneles `/admin` legacy**: la UI ya no pide token, pero varias rutas
   antiguas aún aceptan el fallback. Desactivarlo del todo cuando Producción
   tenga su primer Platform Admin.
6. **Legal** sigue en borrador; falta revisión profesional.
7. **Playwright**: Chromium se instala aparte (`npm run e2e:install`).
8. **Producción**: no se desplegó ni se cambiaron variables/DNS. Antes del
   cutover hay que crear el primer Platform Admin y definir
   `PLATFORM_ADMIN_SECRET`.
