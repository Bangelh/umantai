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

> Estado actual: los ítems de staging están **PENDIENTES** mientras Railway
> mantiene los builds pausados. No se marcan como aprobados por haber corrido
> contra un build anterior.

---

## 0. Preparación

- [ ] `npx tsc --noEmit` limpio.
- [ ] `npm test` verde (incluye i18n, tema, auth, CSRF, rate limit, cleanup).
- [ ] `npm run test:integration` verde contra un clon desechable.
- [ ] `node scripts/check-i18n-strings.mjs --strict` sin hallazgos.
- [ ] `git status` limpio y HEAD anotado.
- [ ] Variables de staging revisadas sin exponer valores.
- [ ] Backup con restore verificado (`CUTOVER_RUNBOOK.md` §2).
- [ ] Ventana de freeze y responsables acordados.
- [ ] Confirmado que Mercado Pago sigue congelado: ningún ítem de este checklist
      exige un pago (de prueba o real) para cerrarse.

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
- [ ] `unit`: `tests/discovery.test.ts`, `tests/geo.test.ts`.
- [ ] `api`: `GET /api/products?q=…` 200 y forma esperada.

## 2. Geolocation

- [ ] “Usar mi ubicación” pide permiso y, al aceptar, muestra “Cerca de …”.
- [ ] Permiso denegado muestra el mensaje y ofrece zona manual.
- [ ] Coordenadas inválidas (lat 91, lng 200) se rechazan con mensaje.
- [ ] Cambiar de zona actualiza resultados sin recargar la página.
- [ ] Quitar ubicación vuelve al modo global.
- [ ] En móvil, el permiso y el layout no tapan el buscador.
- [ ] `unit`: `tests/geo.test.ts`.
- [ ] `ui`: `e2e/public.spec.ts` (geolocalización simulada, si aplica).

## 3. Stores

- [ ] `/<store>` responde 200 y muestra catálogo, nombre y dirección.
- [ ] Tienda inactiva/pendiente no es indexable ni aparece en el buscador.
- [ ] Tienda inexistente → 404.
- [ ] `/negocio` lista solo las tiendas del usuario.
- [ ] “Ver vitrina” abre la tienda correcta.
- [ ] Cambiar de tienda en el nav no mezcla datos.
- [ ] `int`: `tests/multi-tenant.integration.test.ts`.

## 4. Catalog

- [ ] Catálogo maestro lista productos y filtra por categoría/marca.
- [ ] Producto de tienda muestra precio, unidad y disponibilidad correctos.
- [ ] Producto archivado no aparece en la vitrina.
- [ ] Producto sin stock se muestra como agotado, no como disponible.
- [ ] Imágenes cargan (o fallback) sin 404 en consola.
- [ ] `int`: `tests/multi-store-catalog.integration.test.ts`.
- [ ] `api`: `GET /api/products`, `GET /api/products/<slug>`.

## 5. Variants

- [ ] Producto con talla/color exige elegir combinación antes de agregar.
- [ ] Combinación agotada se deshabilita y no permite agregar.
- [ ] Cambiar de variante actualiza stock y SKU mostrados.
- [ ] Precio por variante (si existe) prevalece sobre el base.
- [ ] Carrito guarda la variante correcta (no la primera).
- [ ] `unit`: `tests/commerce.variants.test.ts`.

## 6. Cart single-store

- [ ] Agregar producto de otra tienda pide confirmación y vacía el carrito.
- [ ] “Mantener carrito actual” no modifica nada.
- [ ] Cantidades +/− actualizan totales y no bajan de 1.
- [ ] Quitar ítem y vaciar carrito funcionan.
- [ ] Totales coinciden con precio × cantidad (centavos enteros).
- [ ] Recargar la página conserva el carrito.
- [ ] `unit`: `tests/cart.single-store.test.ts`.

## 7. Guest checkout

- [ ] Checkout sin sesión pide correo y permite continuar.
- [ ] Correo inválido se rechaza en cliente y servidor.
- [ ] Stock insuficiente muestra el faltante y no crea el pedido.
- [ ] Pedido creado → 201 con número `UM-…` y enlace público.
- [ ] La reserva dura lo configurado (30 min) y se muestra la hora.
- [ ] `POST /api/orders` con `Origin` ajeno → 403 (CSRF).
- [ ] `unit`: `tests/checkout.confirmation.test.ts`, `tests/commerce.reservations.test.ts`.
- [ ] `api`: crear pedido de prueba y verificar stock reservado.

## 8. Authenticated checkout

- [ ] Con sesión, el pedido queda asociado al usuario.
- [ ] El correo de la cuenta se usa por defecto y se puede cambiar.
- [ ] Cerrar sesión durante el checkout no pierde el carrito.
- [ ] El pedido aparece en “Mis pedidos” inmediatamente.
- [ ] Un usuario no puede ver pedidos de otro (403/404).
- [ ] `int`: `tests/multi-tenant.integration.test.ts`.

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
- [ ] `int`: `tests/multi-tenant.integration.test.ts`.

## 11. Inventory

- [ ] `/admin/inventario` lista SKUs con físico/reservado/disponible.
- [ ] Entrada de mercadería crea movimiento `receipt` y sube el físico.
- [ ] Ajuste exige motivo y no deja físico < reservado (409).
- [ ] Umbral de stock bajo se guarda y cambia el estado.
- [ ] Historial filtra por tipo, pedido y fechas; ledger es append-only.
- [ ] `unit`: `tests/inventory-*.test.ts`.
- [ ] `api`: receipt + ajuste + ledger contra staging.

## 12. Analytics

- [ ] `/admin/analytics` carga con sesión de Platform Admin.
- [ ] KPIs del período coinciden con pedidos pagados (no pendientes).
- [ ] Cambio de período (hoy/7/30/personalizado) actualiza datos.
- [ ] Rango inválido (desde > hasta) muestra error y no consulta.
- [ ] Serie diaria/semanal y “mejor día/semana” coherentes.
- [ ] Stock bajo/agotado refleja el estado actual.
- [ ] `unit`: `tests/analytics.domain.test.ts`.
- [ ] `int`: `tests/analytics.integration.test.ts`.

## 13. Plans / subscriptions / promos

- [ ] `/admin/planes` lista planes Free/Starter/Growth con límites.
- [ ] Upgrade aplica de inmediato; downgrade se programa al fin de período.
- [ ] Límite de SKU bloquea publicar y explica cómo resolverlo.
- [ ] Cancelación mantiene beneficios hasta el fin del período.
- [ ] Código +1 mes canjeable una vez por tienda y respeta máximo de canjes.
- [ ] Simulación interna de fallo de cobro deja el estado esperado (sin pasarela
      real ni Mercado Pago).
- [ ] Historial de eventos registra cada operación.
- [ ] `unit`: `tests/billing.domain.test.ts`.
- [ ] `int`: `tests/billing.integration.test.ts`.

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
- [ ] `unit`: `tests/auth-lifecycle.test.ts`, `tests/platform-admin.test.ts`.
- [ ] `int`: ciclo completo en `tests/multi-tenant.integration.test.ts`.
- [ ] `ui`: `e2e/auth.spec.ts`.

## 15. Platform Admin

- [ ] `/admin` sin sesión muestra la pantalla de acceso, **sin campo de token**.
- [ ] Cuenta no autorizada → “Esta cuenta no es Platform Admin” (403).
- [ ] Cuenta autorizada canjea sesión y ve el panel.
- [ ] La cookie es HttpOnly, SameSite=Strict y expira en 8 h.
- [ ] “Salir” borra la cookie de admin y mantiene la sesión de usuario.
- [ ] `/api/admin/*` sin cookie/token → 401/503; nunca 200.
- [ ] En Producción, `ALLOW_ADMIN_TOKEN_FALLBACK` no está definido.
- [ ] `unit`: `tests/admin-ui.test.ts`, `tests/platform-admin.test.ts`.
- [ ] `ui`: `e2e/admin.spec.ts`.

## 16. Tenant isolation / RLS

- [ ] Un merchant no lee ni escribe pedidos/inventario de otra tienda.
- [ ] Un cliente no ve pedidos de otro por API ni por URL.
- [ ] `/api/merchant/stores/<otra>/...` → 403/404.
- [ ] `022_rls_tenant_isolation.sql` aplicada y RLS activa en las tablas.
- [ ] Las políticas no bloquean al rol de la app en operaciones legítimas.
- [ ] `int`: `tests/rls.integration.test.ts`, `tests/tenant-guards.integration.test.ts`,
      `tests/multi-tenant.integration.test.ts`.
- [ ] `unit`: `tests/tenancy.test.ts`.

## 17. es / en

- [ ] `LanguageSwitcher` cambia el idioma sin recargar a otra ruta.
- [ ] Todo el comercio (home, buscador, tienda, producto, carrito, checkout,
      pedido, cuenta, vender, negocio, contacto) cambia de idioma.
- [ ] Paneles internos (inventario, analytics, catálogo, planes) cambian.
- [ ] Fechas/moneda se mantienen en `es-PE`/PEN (no se traduce el dinero).
- [ ] El contenido de las tiendas **no** se traduce.
- [ ] La preferencia persiste al recargar (cookie `umantai_locale`).
- [ ] No hay claves crudas visibles (`store.available`) ni textos mezclados.
- [ ] `unit`: `tests/i18n.test.ts`, `tests/i18n-ui.test.ts`.

## 18. Light / dark / system

- [ ] El toggle recorre claro → oscuro → sistema.
- [ ] “Sistema” sigue el `prefers-color-scheme` en vivo.
- [ ] No hay flash de tema incorrecto al recargar.
- [ ] Texto y bordes legibles en ambos temas (contraste AA).
- [ ] Estados (éxito/error/warning) mantienen contraste en claro.
- [ ] Formularios, tablas, gráficos y kiosco se ven bien en ambos.
- [ ] La preferencia persiste (cookie + localStorage).
- [ ] `unit`: `tests/theme.test.ts`.
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
- [ ] `node scripts/security-smoke.mjs` sin hallazgos.
- [ ] `unit`: `tests/security-headers.test.ts`, `tests/csrf-proxy.test.ts`,
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
      `/cart`, `/list` y publica el sitemap.
- [ ] `sitemap.xml` incluye home, catálogo, contacto, legal y productos.
- [ ] Canonical correcto en cada página.
- [ ] Open Graph/Twitter con título y descripción.
- [ ] Staging/preview con `noindex` (no compite con Producción).
- [ ] 404 real para rutas inexistentes (no 200 blando).
- [ ] `unit`: `tests/legal-config.test.ts` (canonical/legal).

## 23. Cron

- [ ] `GET /api/cron/expire-reservations` sin `CRON_SECRET` → 401.
- [ ] Con secreto → 200 y libera solo reservas vencidas.
- [ ] `GET /api/cron/billing` sin secreto → 401; con secreto → 200 idempotente.
- [ ] Servicio `cron` corre ambos jobs en orden cada 15 min.
- [ ] Si un job falla, el otro corre y el proceso sale 1.
- [ ] El cron de Vercel queda desactivado durante la convivencia.
- [ ] `unit`: `tests/cron-runner.test.ts`.

## 24. Backups

- [ ] Dump completo + schema-only con SHA-256 registrado.
- [ ] Restore verificado con `pg_restore --exit-on-error`.
- [ ] Fingerprint del restore idéntico al origen.
- [ ] Conteos de tablas críticas coinciden.
- [ ] Backup copiado fuera del volumen de Railway.
- [ ] Retención ≥ 30 días y responsable nominado.
- [ ] Rollback de datos probado en staging.

## 25. Legal placeholders

- [ ] `/legal` y los 5 documentos responden 200.
- [ ] Los `[PENDIENTE: …]` visibles son solo los datos que el negocio no
      confirmó (razón social, RUC, domicilio fiscal, jurisdicción).
- [ ] Correo de atención, correo legal y WhatsApp salen de
      `config/business.ts` (sin duplicados hardcodeados en páginas).
- [ ] No se inventó ningún dato legal.
- [ ] Aviso de “documento en borrador” visible, con la lista de datos faltantes
      y la marca de “no definitivo para lanzamiento público”.
- [ ] La Política de Reembolso dice que no hay reembolsos voluntarios generales
      **sin perjuicio** de los derechos del consumidor, y no limita derechos
      irrenunciables.
- [ ] Enlaces a términos/privacidad desde checkout y contacto funcionan.
- [ ] `unit`: `tests/legal-config.test.ts`.

## 25.1 Libro de Reclamaciones

Implementado en `/libro-de-reclamaciones` (ver `LIBRO_RECLAMACIONES.md`).

- [ ] Enlace permanente y visible en footer, contacto, legal y pedido.
- [ ] Registra quejas y reclamos con numeración correlativa.
- [ ] Incluye los campos del Anexo I (D.S. N.º 011-2011-PCM).
- [ ] Entrega constancia imprimible y copia por correo cuando Resend está activo.
- [ ] Seguimiento con código aleatorio, sin PII y sin enumeración.
- [ ] Bandeja `/admin/reclamaciones` con plazo y respuesta única.
- [ ] `unit` + integración + Playwright del flujo.
- [ ] **Bloqueo restante:** datos del titular (razón social, RUC, domicilio,
      jurisdicción) y revisión legal. Mientras falten, el formulario muestra
      `[PENDIENTE: …]` y “no listo para lanzamiento público”.
- [ ] Decidir feriados: cargar `PERU_HOLIDAYS` o aceptar por escrito responder
      antes del vencimiento cuando caiga en feriado.

## 26. Mercado Pago (CONGELADO externamente — fuera de alcance)

> No se ejecutan pagos, ni de prueba ni reales, y no se tocan Preferences,
> Orders, webhooks, callbacks ni credenciales. Esta sección **no bloquea** el
> cierre del QA ni el cutover: sólo verifica que el flujo congelado siga intacto.

- [ ] El diff del release no introduce cambios funcionales en pagos (sólo
      textos/i18n si aplica).
- [ ] `unit`: `tests/mercadopago.*.test.ts`, `tests/mp-orders.cleanroom.test.ts`,
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

- [ ] Todos los ítems tienen evidencia enlazada.
- [ ] Los pendientes externos están listados y aceptados por el negocio.
- [ ] `CUTOVER_RUNBOOK.md` §10 (GO/NO-GO) firmado.
- [ ] Fecha de revisión post-cutover (7 y 30 días) agendada.
