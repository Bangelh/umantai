# FINAL QA CHECKLIST — pre-cutover

**Uso:** marcar cada casilla con evidencia (comando, respuesta HTTP, captura o
test). Un ítem sin evidencia es **pendiente**, no aprobado.
**Base de pruebas:** staging (`https://web-staging-6756.up.railway.app`) con el
commit desplegado; los tests locales corren sin servicios externos.

**Leyenda de automatización**

- `unit` → `npm test`
- `int` → `npm run test:integration` (PostgreSQL efímero/clon)
- `api` → `curl`/script contra staging
- `ui` → Playwright (`npm run e2e`)
- `manual` → revisión humana con evidencia

> **Mercado Pago de pedidos está CONGELADO externamente** (checkout hospedado,
> ver `MP_ORDERS_STATUS.md`). No se ejecutan pagos de prueba ni reales y no se
> tocan Preferences, Orders, webhooks, callbacks ni credenciales. Por eso **no
> hay ítems de pago** en esta checklist: el congelamiento **no bloquea** staging
> QA, hardening, final QA ni la preparación del cutover.

**Estado 2026-10-24 (staging `557f85b`):** `/api/health` 200 con base
reachable. Las líneas `unit`/`int` quedan verificadas por la corrida completa:
unit 470/470, integración 103/103, i18n `--strict` sin hallazgos. También se
cerraron hoy los drills de backup/restore, rollback (código y datos) y
`security-smoke` 22/22. Lo que sigue abierto es **manual** (recorrido humano de
UI/UX/accesibilidad) o **externo** (datos legales reales, revisión legal,
ventana y responsables, backup fuera del volumen, Resend real,
Producción/DNS, Mercado Pago congelado). Ver §28.

---

## 0. Preparación

- [x] `npx tsc --noEmit` limpio. (2026-10-24, exit 0)
- [x] `npm test` verde (incluye i18n, tema, auth, CSRF, rate limit, cleanup).
      (470/470)
- [x] `npm run test:integration` verde contra un clon desechable.
      (103/103, embedded PostgreSQL)
- [x] `node scripts/check-i18n-strings.mjs --strict` sin hallazgos.
      (964 usos de claves, 0 strings hardcodeados)
- [x] `git status` limpio y HEAD anotado. (`557f85b`, sólo artefactos
      preexistentes no versionados)
- [x] Variables de staging revisadas sin exponer valores. (claves listadas,
      credencial de PostgreSQL rotada)
- [x] Backup con restore verificado (`CUTOVER_RUNBOOK.md` §2). (ver §24)
- [ ] Ventana de freeze y responsables acordados. — **externo**: decisión de
      negocio, no verificable técnicamente.
- [x] Confirmado que Mercado Pago sigue congelado: ningún ítem de este checklist
      exige un pago (de prueba o real) para cerrarse. (ver §26)

---

## 1. Discovery / search

- [ ] Home carga y muestra el buscador; placeholder y botón traducidos (es/en).
- [ ] `GET /?q=arroz` devuelve resultados y cuenta correcta.
- [ ] Búsqueda sin resultados muestra el mensaje previsto, sin error.
- [ ] Búsqueda con acentos (`arroz`, `camión`) no rompe.
- [ ] Filtros de radio y zona se reflejan en la URL y en los resultados.
- [ ] Orden por distancia/precio es estable entre recargas.
- [ ] Paginación/“mostrando X de Y” coincide con el total.
- [ ] Tienda sin productos no aparece como resultado con stock.
^- [x] `unit`: `tests/discovery.test.ts`, `tests/geo.test.ts`.
- [ ] `api`: `GET /api/products?q=…` 200 y forma esperada.

## 2. Geolocation

- [ ] “Usar mi ubicación” pide permiso y, al aceptar, muestra “Cerca de …”.
- [ ] Permiso denegado muestra el mensaje y ofrece zona manual.
- [ ] Coordenadas inválidas (lat 91, lng 200) se rechazan con mensaje.
- [ ] Cambiar de zona actualiza resultados sin recargar la página.
- [ ] Quitar ubicación vuelve al modo global.
- [ ] En móvil, el permiso y el layout no tapan el buscador.
^- [x] `unit`: `tests/geo.test.ts`.
- [ ] `ui`: `e2e/public.spec.ts` (geolocalización simulada, si aplica).

## 3. Stores

- [ ] `/<store>` responde 200 y muestra catálogo, nombre y dirección.
- [ ] Tienda inactiva/pendiente no es indexable ni aparece en el buscador.
- [ ] Tienda inexistente → 404.
- [ ] `/negocio` lista solo las tiendas del usuario.
- [ ] “Ver vitrina” abre la tienda correcta.
- [ ] Cambiar de tienda en el nav no mezcla datos.
^- [x] `int`: `tests/multi-tenant.integration.test.ts`.

## 4. Catalog

- [ ] Catálogo maestro lista productos y filtra por categoría/marca.
- [ ] Producto de tienda muestra precio, unidad y disponibilidad correctos.
- [ ] Producto archivado no aparece en la vitrina.
- [ ] Producto sin stock se muestra como agotado, no como disponible.
- [ ] Imágenes cargan (o fallback) sin 404 en consola.
^- [x] `int`: `tests/multi-store-catalog.integration.test.ts`.
- [ ] `api`: `GET /api/products`, `GET /api/products/<slug>`.

## 5. Variants

- [ ] Producto con talla/color exige elegir combinación antes de agregar.
- [ ] Combinación agotada se deshabilita y no permite agregar.
- [ ] Cambiar de variante actualiza stock y SKU mostrados.
- [ ] Precio por variante (si existe) prevalece sobre el base.
- [ ] Carrito guarda la variante correcta (no la primera).
^- [x] `unit`: `tests/commerce.variants.test.ts`.

## 6. Cart single-store

- [ ] Agregar producto de otra tienda pide confirmación y vacía el carrito.
- [ ] “Mantener carrito actual” no modifica nada.
- [ ] Cantidades +/− actualizan totales y no bajan de 1.
- [ ] Quitar ítem y vaciar carrito funcionan.
- [ ] Totales coinciden con precio × cantidad (centavos enteros).
- [ ] Recargar la página conserva el carrito.
^- [x] `unit`: `tests/cart.single-store.test.ts`.

## 7. Guest checkout

- [ ] Checkout sin sesión pide correo y permite continuar.
- [ ] Correo inválido se rechaza en cliente y servidor.
- [ ] Stock insuficiente muestra el faltante y no crea el pedido.
- [ ] Pedido creado → 201 con número `UM-…` y enlace público.
- [ ] La reserva dura lo configurado (30 min) y se muestra la hora.
- [ ] `POST /api/orders` con `Origin` ajeno → 403 (CSRF).
^- [x] `unit`: `tests/checkout.confirmation.test.ts`, `tests/commerce.reservations.test.ts`.
- [ ] `api`: crear pedido de prueba y verificar stock reservado.

## 8. Authenticated checkout

- [ ] Con sesión, el pedido queda asociado al usuario.
- [ ] El correo de la cuenta se usa por defecto y se puede cambiar.
- [ ] Cerrar sesión durante el checkout no pierde el carrito.
- [ ] El pedido aparece en “Mis pedidos” inmediatamente.
- [ ] Un usuario no puede ver pedidos de otro (403/404).
^- [x] `int`: `tests/multi-tenant.integration.test.ts`.

## 9. Customer history

- [ ] `/cuenta` lista solo pedidos del usuario, con estado y total.
- [ ] “Ver detalle” abre `/pedido/<token>` correcto.
- [ ] Invitado sin verificación no ve historial ajeno.
- [ ] Pedido cancelado/expirado se muestra con su estado real.
- [ ] `api`: `GET /api/account/orders` con y sin sesión (401 sin sesión).

## 10. Merchant

- [ ] `/vender` crea tienda **inactiva** y muestra “pendiente de aprobación”.
- [ ] Sin sesión, `/vender` manda a `/ingresar?next=/vender`.
- [ ] Panel `/negocio/<id>` muestra solo esa tienda.
- [ ] Crear producto propio y desde catálogo maestro funciona.
- [ ] Editar precio/stock/publicar/archivar funciona.
- [ ] Subir logo/imagen respeta tipo y tamaño; error muestra mensaje.
- [ ] Un merchant no puede operar la tienda de otro (403).
^- [x] `int`: `tests/multi-tenant.integration.test.ts`.

## 11. Inventory

- [ ] `/admin/inventario` lista SKUs con físico/reservado/disponible.
- [ ] Entrada de mercadería crea movimiento `receipt` y sube el físico.
- [ ] Ajuste exige motivo y no deja físico < reservado (409).
- [ ] Umbral de stock bajo se guarda y cambia el estado.
- [ ] Historial filtra por tipo, pedido y fechas; ledger es append-only.
^- [x] `unit`: `tests/inventory-*.test.ts`.
- [ ] `api`: receipt + ajuste + ledger contra staging.

## 12. Analytics

- [ ] `/admin/analytics` carga con sesión de Platform Admin.
- [ ] KPIs del período coinciden con pedidos pagados (no pendientes).
- [ ] Cambio de período (hoy/7/30/personalizado) actualiza datos.
- [ ] Rango inválido (desde > hasta) muestra error y no consulta.
- [ ] Serie diaria/semanal y “mejor día/semana” coherentes.
- [ ] Stock bajo/agotado refleja el estado actual.
^- [x] `unit`: `tests/analytics.domain.test.ts`.
^- [x] `int`: `tests/analytics.integration.test.ts`.

## 13. Plans / subscriptions / promos

- [ ] `/admin/planes` lista planes Free/Starter/Growth con límites.
- [ ] Upgrade aplica de inmediato; downgrade se programa al fin de período.
- [ ] Límite de SKU bloquea publicar y explica cómo resolverlo.
- [ ] Cancelación mantiene beneficios hasta el fin del período.
- [ ] Código +1 mes canjeable una vez por tienda y respeta máximo de canjes.
- [ ] Simulación interna de fallo de cobro deja el estado esperado (sin pasarela
      real ni Mercado Pago).
- [ ] Historial de eventos registra cada operación.
^- [x] `unit`: `tests/billing.domain.test.ts`.
^- [x] `int`: `tests/billing.integration.test.ts`.

## 14. Auth lifecycle

- [ ] Registro con correo nuevo crea cuenta e inicia sesión.
- [ ] Registro con correo existente no filtra si la cuenta existe.
- [ ] Login correcto/incorrecto (mensaje genérico, sin enumeración).
- [ ] Contraseña < 8 caracteres se rechaza.
- [ ] “Olvidé mi contraseña” responde igual exista o no la cuenta.
- [ ] Enlace de reset es de un solo uso y vence en 1 h.
- [ ] Cambio de contraseña exige la actual y cierra otras sesiones.
- [ ] Verificación de correo: envío, enlace y estado en `/cuenta`.
- [ ] Logout invalida la sesión y vuelve a estado anónimo.
^- [x] `unit`: `tests/auth-lifecycle.test.ts`, `tests/platform-admin.test.ts`.
^- [x] `int`: ciclo completo en `tests/multi-tenant.integration.test.ts`.
- [ ] `ui`: `e2e/auth.spec.ts`.

## 15. Platform Admin

- [ ] `/admin` sin sesión muestra la pantalla de acceso, **sin campo de token**.
- [ ] Cuenta no autorizada → “Esta cuenta no es Platform Admin” (403).
- [ ] Cuenta autorizada canjea sesión y ve el panel.
- [ ] La cookie es HttpOnly, SameSite=Strict y expira en 8 h.
- [ ] “Salir” borra la cookie de admin y mantiene la sesión de usuario.
- [ ] `/api/admin/*` sin cookie/token → 401/503; nunca 200.
- [ ] En Producción, `ALLOW_ADMIN_TOKEN_FALLBACK` no está definido.
^- [x] `unit`: `tests/admin-ui.test.ts`, `tests/platform-admin.test.ts`.
- [ ] `ui`: `e2e/admin.spec.ts`.

## 16. Tenant isolation / RLS

- [ ] Un merchant no lee ni escribe pedidos/inventario de otra tienda.
- [ ] Un cliente no ve pedidos de otro por API ni por URL.
- [ ] `/api/merchant/stores/<otra>/...` → 403/404.
- [ ] `022_rls_tenant_isolation.sql` aplicada y RLS activa en las tablas.
- [ ] `023_consumer_complaints.sql` y `024_complaint_assignment.sql` aplicadas
      (tabla, secuencia, responsable y autor de la respuesta).
- [ ] Las políticas no bloquean al rol de la app en operaciones legítimas.
^- [x] `int`: `tests/rls.integration.test.ts`, `tests/tenant-guards.integration.test.ts`,
      `tests/multi-tenant.integration.test.ts`.
^- [x] `unit`: `tests/tenancy.test.ts`.

## 17. es / en

- [ ] `LanguageSwitcher` cambia el idioma sin recargar a otra ruta.
- [ ] Todo el comercio (home, buscador, tienda, producto, carrito, checkout,
      pedido, cuenta, vender, negocio, contacto) cambia de idioma.
- [ ] Paneles internos (inventario, analytics, catálogo, planes) cambian.
- [ ] Fechas/moneda se mantienen en `es-PE`/PEN (no se traduce el dinero).
- [ ] El contenido de las tiendas **no** se traduce.
- [ ] La preferencia persiste al recargar (cookie `umantai_locale`).
- [ ] No hay claves crudas visibles (`store.available`) ni textos mezclados.
^- [x] `unit`: `tests/i18n.test.ts`, `tests/i18n-ui.test.ts`.

## 18. Light / dark / system

- [ ] El toggle recorre claro → oscuro → sistema.
- [ ] “Sistema” sigue el `prefers-color-scheme` en vivo.
- [ ] No hay flash de tema incorrecto al recargar.
- [ ] Texto y bordes legibles en ambos temas (contraste AA).
- [ ] Estados (éxito/error/warning) mantienen contraste en claro.
- [ ] Formularios, tablas, gráficos y kiosco se ven bien en ambos.
- [ ] La preferencia persiste (cookie + localStorage).
^- [x] `unit`: `tests/theme.test.ts`.
- [ ] `ui`: `e2e/responsive.spec.ts`.

## 19. Mobile / tablet / desktop

- [ ] 360×640: nav inferior visible, sin scroll horizontal.
- [ ] 768×1024: grillas de 2 columnas y tablas con scroll.
- [ ] 1280×800: layout completo, sin elementos cortados.
- [ ] Botones y campos ≥ 44 px de alto en móvil.
- [ ] El teclado virtual no tapa el botón de confirmar.
- [ ] `ui`: `e2e/responsive.spec.ts` (viewports definidos).

## 20. Security

- [ ] CSP con nonce en todas las páginas; `script-src` sin `unsafe-inline`.
- [ ] `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` presentes.
- [ ] CSRF: POST con `Origin` ajeno → 403; webhooks exentos por firma.
- [ ] Rate limit en login, contacto, órdenes y admin (429 con `Retry-After`).
- [ ] No hay secretos en el bundle ni en `/debug` público.
- [ ] `/debug*` requiere sesión real; no indexado.
- [ ] Kiosco exige clave de dispositivo; PIN no se devuelve por API.
- [ ] Webhook de pago valida firma e idempotencia por `unit` (no se invoca a
      Mercado Pago desde el QA).
- [x] `node scripts/security-smoke.mjs` sin hallazgos. (2026-10-24: 22/22
      checks, `failed: []`)
^- [x] `unit`: `tests/security-headers.test.ts`, `tests/csrf-proxy.test.ts`,
      `tests/rate-limit.test.ts`, `tests/platform-admin.test.ts`, `tests/admin-ui.test.ts`.

## 21. Accessibility

- [ ] Un solo `h1` por página y jerarquía de encabezados correcta.
- [ ] Todos los inputs tienen `label` o `aria-label`.
- [ ] Foco visible en teclado en todos los controles.
- [ ] “Saltar al contenido” funciona como primer tab.
- [ ] Imágenes con `alt` (decorativas con `alt=""`).
- [ ] Contraste AA en texto normal y grande.
- [ ] `aria-live` en estados de carga/resultado del kiosco.
- [ ] Formularios anuncian errores con `role="alert"`/`aria-describedby`.
- [ ] `prefers-reduced-motion` respetado.
- [ ] `manual`: recorrido con teclado y lector de pantalla.

## 22. SEO

- [ ] `robots.txt` bloquea `/admin`, `/api/`, `/debug`, `/kiosk`, `/pedido/`,
      `/cart`, `/list` y publica el sitemap. — **Producción**: en staging el
      `robots.txt` es `Disallow: /` a propósito; la lista fina sólo se puede
      validar contra el dominio público (no se toca acá).
- [x] `sitemap.xml` incluye home, catálogo, contacto, legal y productos.
      (34 URLs, 21 de productos)
- [x] Canonical correcto en cada página. (home: `…railway.app`, absoluto)
- [x] Open Graph/Twitter con título y descripción. (og:title/description/url)
- [x] Staging/preview con `noindex` (no compite con Producción).
      (`robots: noindex, nofollow` + `Disallow: /`)
- [x] 404 real para rutas inexistentes (no 200 blando). (`/ruta-…` → 404)
^- [x] `unit`: `tests/legal-config.test.ts` (canonical/legal).

## 23. Cron

- [ ] `GET /api/cron/expire-reservations` sin `CRON_SECRET` → 401.
- [ ] Con secreto → 200 y libera solo reservas vencidas.
- [ ] `GET /api/cron/billing` sin secreto → 401; con secreto → 200 idempotente.
- [ ] Servicio `cron` corre ambos jobs en orden cada 15 min.
- [ ] Si un job falla, el otro corre y el proceso sale 1.
- [ ] El cron de Vercel queda desactivado durante la convivencia.
^- [x] `unit`: `tests/cron-runner.test.ts`.

## 24. Backups

- [x] Dump completo + schema-only con SHA-256 registrado. (`pg_dump -Fc`
      custom, 303 615 bytes, sha256 `ed742dd4…2998b`; ver §28)
- [x] Restore verificado con `pg_restore --exit-on-error`. (base desechable,
      exit 0)
- [x] Fingerprint del restore **equivalente** al origen: mismos 34/35 objetos,
      413 columnas, 165 constraints, 135 índices, 54 funciones, 22 triggers y
      7/7 checks de migración. Única diferencia: paréntesis redundantes en la
      definición deparsada de `contact_messages_email_check` (semánticamente
      idéntica, sin efecto).
- [x] Conteos de tablas críticas coinciden. (orders 52, order_items 52,
      stores 41, master_products 30, store_products 107, users 88,
      email_outbox 84, inventory_movements 191, consumer_complaints 1→0 tras
      cleanup E2E)
- [ ] Backup copiado fuera del volumen de Railway. — **externo/operativo**:
      requiere destino de almacenamiento y credenciales que no se tocan acá.
- [ ] Retención ≥ 30 días y responsable nominado. — **externo**: decisión de
      negocio/operación.
- [x] Rollback de datos probado en staging. (drift: `email_outbox` 84→0;
      drop/recreate + `pg_restore --exit-on-error` → 84 de nuevo)

## 25. Legal placeholders

- [x] `/legal` y los 5 documentos responden 200. (`/legal`,
      `/legal/terminos`, `/legal/privacidad`, … → 200)
- [x] Los `[PENDIENTE: …]` visibles son solo los datos que el negocio no
      confirmó (razón social, RUC, domicilio fiscal, jurisdicción).
- [x] Correo de atención, correo legal y WhatsApp salen de
      `config/business.ts` (sin duplicados hardcodeados en páginas).
      (`tests/legal-config.test.ts`)
- [x] No se inventó ningún dato legal. (sólo placeholders declarados)
- [x] Aviso de “documento en borrador” visible, con la lista de datos faltantes
      y la marca de “no definitivo para lanzamiento público”. (E2E
      `e2e/public.spec.ts`)
- [x] La Política de Reembolso dice que no hay reembolsos voluntarios generales
      **sin perjuicio** de los derechos del consumidor, y no limita derechos
      irrenunciables. (E2E)
- [ ] Enlaces a términos/privacidad desde checkout y contacto funcionan. —
      **manual**: contacto/legal verificados por HTTP; el recorrido de checkout
      queda para la revisión humana.
- [ ] Datos del titular (razón social, RUC, domicilio, jurisdicción) y revisión
      legal final. — **externo**: los aporta el negocio.
^- [x] `unit`: `tests/legal-config.test.ts`.

## 25.1 Libro de Reclamaciones

Implementado en `/libro-de-reclamaciones` (ver `LIBRO_RECLAMACIONES.md`).

- [x] Enlace permanente y visible en footer, contacto, legal y pedido.
      (home, `/contacto` y `/legal` sirven `/libro-de-reclamaciones`)
- [x] Registra quejas y reclamos con numeración correlativa. (E2E + unit)
- [x] Incluye los campos del Anexo I (D.S. N.º 011-2011-PCM).
      (`tests/complaints.test.ts`)
- [x] Entrega constancia imprimible. (E2E: botón “Imprimir o guardar PDF”)
- [ ] Copia por correo cuando Resend está activo. — **externo**: staging no
      envía correo real; el flujo queda en `not_configured` y la constancia se
      muestra en pantalla.
- [x] Seguimiento con código aleatorio, sin PII y sin enumeración. (E2E:
      `/seguimiento/RC-000001` y código inventado → 404)
- [x] Bandeja `/admin/reclamaciones` con plazo y respuesta única. (unit,
      integración y E2E de la puerta de sesión)
- [x] `unit` + integración + Playwright del flujo. (`complaints.test.ts`,
      `complaints.integration.test.ts`, `e2e/public.spec.ts`)
- [ ] **Bloqueo restante:** datos del titular (razón social, RUC, domicilio,
      jurisdicción) y revisión legal. — **externo**.
- [x] Responsable operativo visible en la bandeja: Platform Admin (UMANTAI) por
      defecto y correo del admin al tomar la hoja. (`assigned_to`,
      `assigned_at`, `answered_by`; migración 024)
- [x] Plazo con feriados nacionales (calendario `2026-2027.1` de
      `lib/peru-holidays.ts`), zona `America/Lima`, sábados y domingos.
      (unit: cruce de fin de semana + feriado; integración: `due_at`)
- [x] La bandeja advierte si un vencimiento cae en un año sin calendario
      (fail-safe: nunca alarga el plazo). (unit + aviso en la UI)
- [x] Historial de respuesta muestra texto, acciones, fecha y autor; una
      respuesta emitida no se sobrescribe. (unit + integración: 409/estado
      `answered` inmutable)
^- [x] `unit`: `tests/complaints.test.ts`; `int`:
      `tests/complaints.integration.test.ts`.

## 26. Mercado Pago (CONGELADO externamente — fuera de alcance)

> No se ejecutan pagos, ni de prueba ni reales, y no se tocan Preferences,
> Orders, webhooks, callbacks ni credenciales. Esta sección **no bloquea** el
> cierre del QA ni el cutover: sólo verifica que el flujo congelado siga intacto.

- [ ] El diff del release no introduce cambios funcionales en pagos (sólo
      textos/i18n si aplica).
^- [x] `unit`: `tests/mercadopago.*.test.ts`, `tests/mp-orders.cleanroom.test.ts`,
      `tests/payment-simulation.qa.test.ts` en verde, sin red ni credenciales.
- [ ] Credenciales live siguen sólo en Producción; no se emiten ni copian nuevas.
- [ ] Pedido de invitado/autenticado queda `pending_payment` y sirve para el
      resto del QA (historial, merchant, kiosco) sin pasar por pago.
- [ ] Al descongelar: se retoma como fase aparte con su propio checklist
      (`MP_ORDERS_STATUS.md`), fuera de este documento.

> Estado: **congelado por un tercero**. No marcar como pendiente ni como
> bloqueante; se documenta y se sigue.

---

## 27. Cierre

- [ ] Todos los ítems tienen evidencia enlazada. — **parcial**: automatizados y
      drills sí (ver §28); recorrido manual UI/UX queda abierto.
- [ ] Los pendientes externos están listados y aceptados por el negocio.
- [ ] `CUTOVER_RUNBOOK.md` §10 (GO/NO-GO) firmado.
- [ ] Fecha de revisión post-cutover (7 y 30 días) agendada.

---

## 28. Cierre técnico del 2026-10-24 (staging `557f85b`)

> Todo lo de esta sección se ejecutó contra `staging` con
> `https://web-staging-6756.up.railway.app`. No se tocó Producción, DNS,
> Mercado Pago, Resend ni ningún servicio externo.

### 28.1 Evidencia de la corrida

| Verificación | Resultado |
|---|---|
| `/api/health` | 200 · `commit: 557f85b…` · `database.reachable: true` |
| `npx tsc --noEmit` | exit 0 |
| `npm test` | 470/470 |
| `npm run test:integration` | 103/103 |
| `check-i18n-strings --strict` | 964 usos de claves, 0 hardcodeados |
| `security-smoke` | 22/22, `failed: []` |
| Load baseline (24 req, conc. 6) | search p50 275 / p95 533 ms; geo 284/335; store 370/436; product 347/625; health 270/663; error rate 0 % en los cinco |
| Backup | `pg_dump -Fc` 303 615 B · sha256 `ed742dd4…2998b` |
| Restore | `pg_restore --exit-on-error` exit 0 en base desechable · 34/35 objetos, 413 columnas, 165 constraints, 135 índices, 54 funciones, 22 triggers · conteos idénticos |
| Rollback de código | artefacto `049782f` desplegado (`2747600b`) → health OK y textos viejos; candidato `557f85b` (`129ec156`) → health OK y textos nuevos |
| Rollback de datos | drift `email_outbox` 84→0 → drop/recreate + restore → 84 |
| Cleanup E2E | 1 fila `consumer_complaints` (RC-000001) borrada tras verificar las 4 marcas E2E; bandeja en 0 |
| Credencial PostgreSQL | rotada; verificador SCRAM ya no acepta la vieja |

**Lección operativa del rollback:** cambiar sólo `GIT_COMMIT_SHA` en Railway
redespliega *el último artefacto subido*, no el repositorio. Tras un rollback hay
que volver a subir el árbol del candidato con `railway up` y confirmarlo con
`/api/health`, no confiar en el redeploy por variable.

### 28.2 Qué queda abierto y por qué

| Sección | Estado |
|---|---|
| 0 Preparación | Cerrada salvo ventana/responsables (negocio) |
| 1–19 Discovery…Mobile | Automatizado cerrado (`unit`/`int`); recorrido manual de UI/UX pendiente |
| 20 Security | Cerrada (smoke 22/22) |
| 21 Accessibility | **Manual**: teclado y lector de pantalla |
| 22 SEO | Cerrada salvo `robots.txt` de Producción (depende del dominio real) |
| 23 Cron | Pendiente de corrida controlada con `CRON_SECRET`; el servicio existe y los jobs son idempotentes |
| 24 Backups | Cerrada salvo copia fuera del volumen y retención/responsable (operación) |
| 25 Legal | Cerrada salvo datos del titular y revisión legal (negocio) |
| 25.1 Libro | Cerrada salvo datos del titular y envío real por Resend |
| 26 Mercado Pago | Congelado externamente; fuera de alcance |

### 28.3 Pendientes externos (no bloquean staging)

1. Datos del titular y revisión legal → `isLegalReadyForLaunch()` sigue `false`.
2. Copia del backup fuera del volumen de Railway + retención ≥ 30 días.
3. Ventana de convivencia y responsables de cutover/rollback.
4. Resend real para la copia por correo de la constancia.
5. `robots.txt` definitivo y `ALLOW_ADMIN_TOKEN_FALLBACK` en Producción.
6. Recorrido manual de accesibilidad y de checkout.
7. Migraciones 001–024 en Producción (no ejecutadas por instrucción).
