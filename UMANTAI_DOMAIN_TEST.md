# Prueba privada sobre `umantai.com` — Railway staging

**Estado:** prueba privada **ejecutada y validada el 2026-10-27**. `umantai.com`
sirve el candidato `8db205a` del entorno `staging` de Railway a través de
Cloudflare; Vercel quedó intacto y el rollback está listo en §7. Resultados en §11.
**Fecha:** 2026-10-27
**Candidato:** `8db205a` (`feat/railway-staging`) — build
`20261027231516-8db205a` del servicio `web` del entorno **staging** de Railway.
**Alcance:** prueba **privada de experiencia real** para dos personas. **NO** es
lanzamiento público definitivo, **no** es el cutover de `CUTOVER_RUNBOOK.md` y
**no** autoriza crear el entorno `production` de Railway.

> Regla de oro: el dominio se mueve **con el rollback ya escrito** (§7). Si
> aparece un P0/P1, se restaura el registro anterior hacia Vercel (§7.1) y se
> deja staging vivo para diagnóstico.

---

## 1. Estado previo verificado (2026-10-27)

| Comprobación | Resultado |
|---|---|
| HEAD local = candidato | `8db205a` = `8db205add2e2de6f76ea52d9bde6a31a1bb298ec` |
| Rama | `feat/railway-staging` (árbol limpio; 2 untracked históricos) |
| `/api/health` del host staging | `200` · `environment: staging` · `database.reachable: true` · `database.type: pg` · `commit: 8db205a…` · `buildId: 20261027231516-8db205a` |
| Backup de la base de staging | `backups/staging-20261024T234822Z.dump` · 303.615 bytes · cabecera `PGDMP` · sha256 `ed742dd406a555d4724f4970d0dba19c44be4d536a8f5e6f4665240fe072998b` |
| Config de Vercel | **intacta**: no se borró ningún deployment, dominio ni proyecto |

**Limitación honesta del backup:** no se pudo tomar un dump **fresco** desde este
equipo. `Postgres17` solo es accesible por la red privada de Railway (no tiene
proxy TCP público, y abrirlo está fuera de alcance), y `railway ssh` no conecta
(el puerto 22 sale bloqueado desde la red local). El dump verificado es del
**2026-10-24 23:48 UTC** (3 días). La prueba **no es destructiva** (no migra, no
borra, no restaura), así que solo importan las escrituras posteriores a esa
fecha; si hiciera falta limpiarlas, existen `scripts/cleanup-smoke-data.ts` y
`.tools/final-qa-cleanup.mjs`.

---

## 2. Inventario DNS actual de `umantai.com` (antes)

Zona DNS en **Cloudflare** (no en Vercel):

| Tipo | Nombre | Valor | TTL | Proxy |
|---|---|---|---|---|
| NS | `umantai.com` | `cloe.ns.cloudflare.com` · `vern.ns.cloudflare.com` | 86400 | — |
| A | `umantai.com` (`@`) | **`76.76.21.21`** (Vercel) | 300 | DNS only (gris) |
| CNAME | `www.umantai.com` | `afa66e65da7308f0.vercel-dns-016.com` (Vercel) | 600 | DNS only |
| TXT | `_dmarc.umantai.com` | `v=DMARC1; p=none;` | 300 | — |
| AAAA / CAA / MX / TXT(`@`) | — | sin registros | — | — |
| `staging.umantai.com` | — | sin registros (no existe) | — | — |

Contexto: hoy `https://umantai.com` responde **Vercel** con la pantalla de acceso
SSO del equipo (`302 → vercel.com/sso-api`), es decir que Producción está
protegida y **no** sirve el sitio a visitantes anónimos.

---

## 3. Registros que Railway exige para el dominio custom

Dominio creado en Railway (`web`, entorno `staging`):

- ID: `76f5d302-c32f-4d55-ab96-c4592828b891` · creado `2026-10-27T23:13:54Z`
- Estado: `ACTIVE` / `Verified: no` / certificado `VALIDATING_OWNERSHIP`

| Tipo | Nombre | Valor |
|---|---|---|
| CNAME | `@` (raíz) | `co13eu5i.up.railway.app` |
| TXT | `_railway-verify` | `railway-verify=febc1d5dec16f3071db67711cfdcf2bd959dd9c8acd3280eb4706745c19f6644` |

Cloudflare admite **CNAME en la raíz** (flattening), así que no hace falta
convertirlo a A. Se crea en **DNS only**: Railway valida la propiedad y emite el
certificado Let's Encrypt con desafío HTTP sobre el dominio, y un proxy delante
puede interferir en la emisión.

---

## 4. Cambio exacto en Cloudflare (1 registro + 1 TXT)

1. Zona `umantai.com` → DNS → Records.
2. **Reemplazar** el registro `A @ → 76.76.21.21` por
   `CNAME @ → co13eu5i.up.railway.app`, **Proxy status: DNS only**.
   (No pueden coexistir un A y un CNAME con el mismo nombre: se borra el A en el
   mismo paso en que se crea el CNAME.)
3. **Agregar** `TXT _railway-verify = railway-verify=febc1d5d…f6644`.
4. **No tocar** nada más: `www`, `_dmarc`, NS y cualquier otro registro quedan
   igual. `www.umantai.com` sigue apuntando a Vercel (y por eso el rollback es
   tan corto).
5. `MERCADOPAGO_BACK_URL_BASE` y los registros de correo **no** se tocan.

TTL: el A actual está en 300 s; el CNAME nuevo puede quedar en Auto (300 s). No
se requiere bajar TTL 24 h antes porque el registro ya está bajo.

---

## 5. Variables de entorno ajustadas (solo servicio `web`, entorno `staging`)

| Variable | Antes | Ahora |
|---|---|---|
| `BETTER_AUTH_URL` | `https://web-staging-6756.up.railway.app` | `https://umantai.com` |
| `NEXT_PUBLIC_SERVER_URL` | `https://web-staging-6756.up.railway.app` | `https://umantai.com` |
| `NEXT_PUBLIC_SITE_URL` | *(no definida)* | `https://umantai.com` |
| `AUTH_TEST_MODE` | `1` (correo de auth al `email_outbox`) | `0` **temporal** durante la prueba, para recibir verificación y recuperación por correo real · **restaurado a `1`** al cerrar (§11) |

Efecto verificado en el host staging: `<link rel="canonical">` y el `Host:` de
`robots.txt` ya son `https://umantai.com`, y sigue `<meta name="robots"
content="noindex, nofollow">` con `robots.txt` en `Disallow: /`.

Verificado tras el redeploy: `20261027232201-8db205a`, `commit 8db205a`,
`environment: staging`, base `reachable`, `robots.txt` en `Disallow: /` con
`Host: https://umantai.com`, `noindex, nofollow` intacto y
`GET /api/auth/test/outbox` → **404** (confirma que el proveedor de correo ya no
es `test` sino `resend`).

No se tocó ninguna otra variable. En particular **siguen igual**: `APP_ENV=staging`,
`LEGAL_DEMO_DATA=1`, `MP_PAYMENT_SIMULATION=1`,
`ONLINE_PAYMENTS_ENABLED` **sin definir** (cobro online congelado),
`RESEND_FROM_EMAIL=Umantai <soporte@umantai.com>`, y todas las credenciales. El
entorno `production` de Railway sigue **vacío** y `main` sigue **intacto**.

---

## 6. Instrucciones exactas para Cloudflare (las aplica el dueño)

Existen ya los registros en el panel de Railway, pero **no** hay credenciales de
Cloudflare en este entorno (`wrangler` sin sesión, sin `CLOUDFLARE_*`), así que el
cambio lo aplica el dueño a mano en **Cloudflare → `umantai.com` → DNS → Records**.
Mientras no se aplique, **nada público cambia**: `umantai.com` sigue sirviendo
Vercel y Railway solo tiene el dominio creado y sin verificar.

### 6.1 Registro a modificar (1 sola operación)

No pueden coexistir un `A` y un `CNAME` con el mismo nombre: **se elimina el `A` y
se crea el `CNAME` en el mismo paso**.

| Campo | Valor |
|---|---|
| Operación | **Eliminar** `A @` → **Crear** `CNAME @` |
| Tipo | `CNAME` |
| Nombre / host | `@` (la raíz; el panel lo muestra como `umantai.com`) |
| Destino / contenido | `co13eu5i.up.railway.app` |
| Proxy status | **DNS only** (nube gris) — Railway valida la propiedad y emite el TLS por HTTP sobre el dominio |
| TTL | Auto (300 s) |
| **Registro anterior (rollback)** | `A`, nombre `@`, contenido **`76.76.21.21`**, Proxy **DNS only**, TTL Auto |

### 6.2 Registro a agregar (1)

| Campo | Valor |
|---|---|
| Tipo | `TXT` |
| Nombre / host | `_railway-verify` |
| Contenido | `railway-verify=febc1d5dec16f3071db67711cfdcf2bd959dd9c8acd3280eb4706745c19f6644` |
| TTL | Auto |

### 6.3 No tocar

`www` (`CNAME` → `afa66e65da7308f0.vercel-dns-016.com`), `_dmarc`, `send`,
`resend._domainkey`, los NS de Cloudflare y cualquier otro registro. Correo y
`MERCADOPAGO_BACK_URL_BASE` quedan igual.

### 6.4 Qué debe pasar después del cambio

1. Railway verifica la propiedad (`TXT`) y emite el certificado
   (`CERTIFICATE_STATUS_TYPE_VALIDATING_OWNERSHIP` → válido).
2. `https://umantai.com/api/health` responde `200` con
   `environment: staging` y `commit: 8db205a…`.
3. Recién ahí corre la validación de §9.

Avisar cuando esté aplicado para continuar con la validación.

---

## 7. Rollback

### 7.1 Volver `umantai.com` a Vercel (minutos)

1. Cloudflare → DNS: **borrar** el `CNAME @ → co13eu5i.up.railway.app`.
2. **Recrear** `A @ → 76.76.21.21`, Proxy status **DNS only** (TTL Auto/300).
3. Opcional: borrar el `TXT _railway-verify`.
4. Confirmar: `curl -I https://umantai.com` vuelve a responder **Vercel**
   (esperado: `302` a `vercel.com/sso-api` mientras el SSO esté activo).
5. Nada que restaurar del lado de Vercel: el proyecto y el dominio nunca se
   tocaron.

### 7.2 Volver las variables

```bash
railway variable set \
  BETTER_AUTH_URL=https://web-staging-6756.up.railway.app \
  NEXT_PUBLIC_SERVER_URL=https://web-staging-6756.up.railway.app \
  AUTH_TEST_MODE=1 \
  -s web -e staging
railway variable delete NEXT_PUBLIC_SITE_URL -s web -e staging
```

(`AUTH_TEST_MODE=1` es el valor de reposo de staging: sin él, la suite E2E
dependiente de `email_outbox` deja de ser reproducible.)

### 7.3 Quitar el dominio custom de Railway

```bash
railway domain delete 76f5d302-c32f-4d55-ab96-c4592828b891 -s web -e staging
```

El entorno de datos **no** se toca en ningún caso. Si además hubiera que revertir
datos: `scripts/cleanup-smoke-data.ts` / `.tools/final-qa-cleanup.mjs`, o el dump
verificado de §1.

---

## 8. Criterios P0/P1 (gatillan 7.1 de inmediato)

| Señal | Umbral |
|---|---|
| TLS inválido o certificado de otro dominio | cualquier |
| `/api/health` en `umantai.com` con 5xx > 5 min o base inalcanzable | sostenido |
| Cookie de sesión sin `Secure`/`SameSite`, o sesión que no persiste al navegar | reproducible |
| Enlace absoluto, correo o canonical que siga apuntando a `web-staging-6756.up.railway.app` | cualquier caso en la navegación principal |
| Indexación: `index,follow` o sitemap anunciado en `robots.txt` | cualquier |
| Cobro online ofrecido o Mercado Pago llamado | cualquier |
| Datos legales demo **sin** el aviso visible, o `isLegalReadyForLaunch() = true` | cualquier |
| Fuga de secretos en logs o páginas | cualquier |

---

## 9. Validación sobre `https://umantai.com` (post-DNS)

- `/api/health` → `200`, `environment: staging`, `commit 8db205a`, base `reachable`.
- HTTPS/TLS: certificado válido para `umantai.com`, sin error de cadena.
- Páginas: home, búsqueda, tienda, producto, legal/5 documentos,
  `/libro-de-reclamaciones`, `robots.txt` (`Disallow: /`), `/sitemap.xml` **no
  anunciado** en `robots.txt`.
- Auth: registro → verificación → login → logout → recovery (ver §10 sobre el
  modo test y el correo real).
- Cookies: `Secure`, `SameSite`, `HttpOnly` donde corresponda; sesión estable al
  navegar entre páginas.
- Correo: contacto y Libro de Reclamaciones por Resend real; enlaces absolutos en
  el cuerpo del correo apuntando a `https://umantai.com`, nunca al host de staging.
- Comercio: carrito (una tienda y cross-store), checkout hasta `pending_payment`.
- Merchant/admin: acceso autenticado, sin `200` anónimo.
- UI: es/en, light/dark/system, mobile (nav inferior).
- Grep final: **cero** apariciones de `web-staging-6756.up.railway.app` en HTML,
  cabeceras, canonicals o correos durante la navegación por `umantai.com`.

---

## 10. Correo de autenticación durante la prueba (decidido)

`lib/email.server.ts` prioriza `AUTH_TEST_MODE=1` sobre la API key: con él, el
correo de verificación/recuperación **no se envía**, queda en `email_outbox` y el
enlace se lee por `GET /api/auth/test/outbox`.

Para esta prueba de dominio final se decidió **`AUTH_TEST_MODE=0`** (aplicado y
verificado: el outbox responde 404), así que verificación y recuperación llegan
**de verdad** al buzón vía Resend, con remitente
`Umantai <soporte@umantai.com>` y enlaces construidos desde `BETTER_AUTH_URL`
(`https://umantai.com`). Resend está verificado en la zona: `resend._domainkey`
(DKIM) y `send.umantai.com` (SPF + MX de rebotes) existen y no se tocan.

**Al cerrar la prueba se volvió `AUTH_TEST_MODE=1`** (§7.2) para conservar la
suite E2E reproducible de staging, y se confirmó `/api/health` después del
redeploy (§11).

Contacto y Libro de Reclamaciones usan una ruta distinta (`lib/contact.server.ts`,
`lib/complaints-email.server.ts`) que no depende de ese interruptor: envían por
Resend de verdad, y así se verificó (§11).

---

## 11. Resultado de la validación (2026-10-27)

### 11.1 Dominio, TLS y plataforma

| Comprobación | Resultado |
|---|---|
| Propagación DNS | `umantai.com` → **`69.46.46.35`** (Railway), TTL 60; `TXT _railway-verify` presente; CNAME de raíz aplanado por Cloudflare |
| Dominio custom en Railway | `Verified: yes`, `Certificate status: VALID` |
| TLS | `CN=umantai.com`, Let's Encrypt, 2026-10-27 → 2027-01-25, SAN `DNS:umantai.com` |
| HTTP → HTTPS | `301` a `https://umantai.com/` |
| Cabeceras | HSTS, CSP con nonce, `X-Frame-Options: DENY`, `nosniff`, `x-xss-protection` |
| `/api/health` | `200`, `environment: staging`, `commit: 8db205a`, `database.reachable: true` (`pg`) |

> Durante ~2,5 min el borde sirvió el certificado comodín `*.up.railway.app`
mientras Let's Encrypt emitía el del dominio. Se resolvió solo: **no** fue P0.

### 11.2 Páginas y comercio

| Comprobación | Resultado |
|---|---|
| Home, `/contacto`, `/vender`, `/cart`, `/list`, `/ingresar`, `/recuperar`, legal (índice + 5 documentos), `/libro-de-reclamaciones` | `200` |
| `/products` | `308` → `https://umantai.com/` (redirect documentado) |
| Tienda y producto (`/telas-del-sur`, `/telas-del-sur/p/tela-algodon`) | `200`, canonical `https://umantai.com/telas-del-sur/p/tela-algodon` |
| Imagen Open Graph | `200 image/png`; `og:url = https://umantai.com` |
| Pedido real (`POST /api/orders`) | **201** · `UM-2026-001055` · `pending_payment` · PEN |
| Página `/pedido/<token>` | `200` con «pago online no está disponible por ahora» y **sin** botón de Mercado Pago |
| Cobro online | `POST /api/payments/preference` → **503** `online_payments_unavailable` (congelado) |
| Carrito cross-store | `POST /api/orders` con dos tiendas → **409** `mixed_store_cart` |
| CSRF | `POST /api/orders` con `Origin` ajeno → **403** |

### 11.3 Autenticación y correo

| Comprobación | Resultado |
|---|---|
| Registro | `200`; cookie `__Secure-better-auth.session_token` con **HttpOnly; Secure; SameSite=Lax** |
| Sesión / logout | `get-session` devuelve la sesión; `sign-out` `200` y limpia las 3 cookies (`Max-Age=0`); después `get-session` → `null` |
| Login | `200` con cookie nueva; `/cuenta` con sesión `200` y sin sesión `307` → `/ingresar?next=/cuenta` |
| Verificación de email | Enlace real `https://umantai.com/api/auth/verify-email?token=…`; al abrirlo `302` → `https://umantai.com/` y `emailVerified=true` |
| Password reset | Enlace real → `https://umantai.com/restablecer?token=…`; `POST /api/auth/reset-password` `200`; login con la clave nueva `200` y con la vieja **401** |
| Enlaces de correo | `origin` = `https://umantai.com` en verificación y reset; **cero** menciones a `web-staging-6756` |
| Entrega real por Resend | Contacto `delivery: stored` (= aviso **enviado**); Reclamaciones `emailStatus: sent`; sin errores de correo en los logs |
| Contacto (`POST /api/contact`) | `200` |
| Libro de Reclamaciones (`POST /api/complaints`) | **201** · `RC-000004` · `dueAt` 2026-11-18; seguimiento `200` con `noindex, nofollow, nocache`; código inexistente → `404` |

### 11.4 Administración, i18n, tema y mobile

| Comprobación | Resultado |
|---|---|
| `/api/admin/*` sin credencial | `401` (analytics, orders, complaints); `/admin` anónimo no filtra pedidos, reclamos ni correos |
| Admin con `x-admin-token` | `200` en `/api/admin/analytics/summary` |
| Merchant autenticado | `POST /api/merchant/stores` crea tienda; `/negocio` y `/negocio/<id>` `200`; anónimo `307` → `/ingresar?next=/negocio` |
| Índice de sitemap | 34 URLs, todas `https://umantai.com`, cero del host de staging; la tienda de prueba (inactiva) **no** aparece |
| robots.txt / meta | `Disallow: /` + `noindex, nofollow` en las páginas; sitemap **no** anunciado |
| es / en | `lang="es"` con «Buscar/Carrito» y `lang="en"` con «Search/Cart» |
| Tema | `data-theme="light"`/`"dark"` según cookie, `dark` por defecto; tema `system` lo resuelve el script de arranque con `prefers-color-scheme`; ambos temas compilados en el CSS |
| Mobile | `viewport` correcto, nav inferior `lg:hidden fixed bottom-0 … pb-[env(safe-area-inset-bottom)]`, breakpoints `40/48/64/80rem` en el CSS |
| Grep del host de staging | `0` apariciones en 11 páginas (incluye `robots.txt` y `sitemap.xml`), en redirecciones y en los enlaces de correo |

### 11.5 Hallazgos

- **P2 · i18n del footer (preexistente en `8db205a`, no lo causó el dominio):**
  `app/components/SiteFooter.tsx` renderiza `link.label` tomado de
  `lib/navigation.ts`, cuyas etiquetas están solo en español. En la página EN el
  encabezado de cada bloque sale traducido («Shop», «Help», «Legal») pero los
  enlaces quedan «Productos», «Lista de compras», «Carrito», «Privacidad», … El
  escáner `check-i18n-strings.mjs` no lo detecta porque solo mira `app/` y
  `components/`, no `lib/`. Arreglo propuesto (fuera de esta prueba): mover las
  etiquetas a claves de diccionario y usar `t()` en el footer.
- **Vigilar · `www.umantai.com` sigue en Vercel** (CNAME intacto): quien escriba
  «www» ve el SSO de Vercel, no el sitio de staging. Fue el alcance acordado
  (“cambiar únicamente lo necesario”) y es lo que hace corto el rollback; si la
  prueba necesita también `www`, hay que agregar el dominio en Railway.
- **Vigilar · `/sitemap.xml` responde `200`** aunque `robots.txt` bloquea todo y
  no lo anuncia. No se sirve un sitemap “publicado”, pero es alcanzable con la URL
  directa. Cerrarlo exigiría un commit nuevo (dejaría de ser `8db205a`).
- **Por diseño · `/api/admin/session` responde `200` anónimo** con
  `{authenticated:false}`: es la sonda que usa el panel para decidir si muestra el
  acceso. No devuelve datos; los endpoints de datos sí responden `401`.

### 11.6 Limitaciones de la verificación

- **No hay navegador** en este entorno (ni Chrome ni Playwright instalados), así
  que mobile, tema e i18n se verificaron sobre HTML/CSS y cabeceras, no con un
  viewport real. El diálogo de «cambiar de tienda» del carrito (`e2e/commerce.spec.ts`)
  se validó en su contrato de servidor (409 `mixed_store_cart`), no en la UI.
- **La entrega al buzón de los correos de auth** solo puede confirmarla quien lee
  la bandeja: la API key de Resend es de **solo envío**, así que no se puede
  listar lo enviado. Queda evidencia fuerte — `200` en registro y reset, sin
  errores en los logs, y el enlace con host correcto — pero la recepción real
  (dos correos a `juancallerosales19+umantai-dns-test@gmail.com`: verificación y
  reset) es la comprobación de la persona.
- **Datos de prueba creados** en staging: pedido `UM-2026-001055`, reclamo
  `RC-000004`, mensaje de contacto, cuenta
  `juancallerosales19+umantai-dns-test@gmail.com` y la tienda inactiva
  `prueba-dominio-e2e`. Se limpian con `scripts/cleanup-smoke-data.ts` /
  `.tools/final-qa-cleanup.mjs` o se ignoran: staging no es Producción.
