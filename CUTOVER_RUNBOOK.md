# CUTOVER RUNBOOK — Vercel/Neon → Railway

**Alcance:** pasar el tráfico de Producción de Vercel + Neon al entorno Railway
`staging`, sin tocar datos, DNS ni credenciales live hasta que el GO/NO-GO lo
autorice. **Este documento no se ejecutó.** Es el procedimiento a seguir cuando
el negocio lo apruebe y Railway reanude los builds.

**Regla de oro:** cada paso tiene una verificación. Si la verificación falla, se
detiene el cutover y se ejecuta el rollback de la §9. No se "sigue y se arregla
después".

**Última actualización:** 2026-10-22 · **HEAD candidato:** el HEAD local de
`feat/railway-staging` al reanudarse los builds (posterior a `18f945f`).

---

## 0. Contexto y límites

| Elemento | Producción actual | Destino del cutover |
|---|---|---|
| App | Vercel (proyecto `umantai`) | Railway `web` (entorno `staging` → futuro `production`) |
| Base | Neon (Postgres) | Railway `Postgres17` |
| Dominio | `umantai.com` → Vercel | mismo dominio → Railway (solo al final) |
| Pago de pedidos | Mercado Pago (Checkout Pro) | **sin cambios**; se mantiene la misma cuenta |
| Cron | Vercel (`0 3 * * *`) | Railway `cron` (`*/15 * * * *`) |
| Storage | Neon/Supabase legacy | `MEDIA_DRIVER=db` (o R2 si se configura) |

Fuera de alcance de este runbook: cambiar el plan de Railway, abrir PostgreSQL a
Internet, migrar Mercado Pago a otra cuenta, borrar recursos.

**Mercado Pago de pedidos está CONGELADO externamente** (el checkout hospedado
falla antes del login del comprador; ver `MP_ORDERS_STATUS.md`). Este runbook
**no** descongela ni toca Preferences, Orders, webhooks, callbacks ni
credenciales, y la ausencia de pagos reales **no** es criterio de NO-GO.

---

## 1. Preflight

Ejecutar **todo** desde la rama congelada y con el árbol limpio.

```bash
git fetch origin
git checkout feat/railway-staging
git pull --ff-only
git status --short          # solo untracked preexistentes permitidos
git rev-parse HEAD          # anotar el SHA: es el que se despliega
```

Verificaciones locales (deben pasar antes de tocar staging):

```bash
npx tsc --noEmit
npm test                     # unitarios (incluye i18n, tema, CSRF, rate limit, auth)
npm run test:integration     # PostgreSQL efímero (embedded-postgres)
node scripts/check-i18n-strings.mjs --strict
```

- [ ] `tsc` sin errores.
- [ ] `npm test` 100% verde.
- [ ] Integración verde (si `embedded-postgres` no arranca en la máquina, usar
      `INTEGRATION_DATABASE_URL` apuntando a un clon **desechable**, nunca a
      Producción).
- [ ] `check-i18n-strings --strict` sin hallazgos.
- [ ] El HEAD local es el mismo que se va a desplegar; anotarlo en el registro
      de cambios.
- [ ] Railway responde: `railway status` y `railway deployment list` sin errores.
- [ ] `/api/health` actual responde 200 (aunque sea del build anterior).

**Variables que deben existir en el servicio `web`** (sin imprimir valores):
`APP_ENV`, `NIXPACKS_NODE_VERSION`, `DATABASE_URL`, `POSTGRES_URL_NON_POOLING`,
`DB_DRIVER=pg`, `PAYLOAD_SECRET`, `ADMIN_API_SECRET`, `PLATFORM_ADMIN_SECRET`,
`PLATFORM_ADMIN_EMAILS`, `BETTER_AUTH_SECRET`, `KIOSK_ACCESS_CODE`,
`CRON_SECRET`, `NEXT_PUBLIC_SERVER_URL`, `NEXT_PUBLIC_SITE_URL`.
Opcionales: `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `CONTACT_TO_EMAIL`,
`LEGAL_EMAIL`, `NEXT_PUBLIC_WHATSAPP_SALES_PHONE` (ver
`EMAIL_RESEND_SETUP.md` y `ENVIRONMENT_VARIABLES.md`),
`MERCADOPAGO_*` de prueba **sólo si** se autoriza descongelar (hoy no se usan),
`MEDIA_DRIVER`, `R2_*`.
El cobro online queda congelado salvo `ONLINE_PAYMENTS_ENABLED=1`; en este
cutover **no** se define.

Verificación sin exponer valores:

```bash
railway variables --service web --environment staging --kv \
  | sed 's/=.*/=<set>/' | sort
```

---

## 2. Backup

**Antes de cualquier migración o deploy que escriba datos.**

```bash
# El dump se hace dentro del contenedor Postgres o con una URL directa.
# Nunca se imprime la URL ni se commitea el archivo.
node scripts/pg-dump.mjs --out=backups/cutover-$(date -u +%Y%m%dT%H%M%SZ).dump
sha256sum backups/cutover-*.dump
```

- [ ] Dump **custom** completo y dump **schema-only**.
- [ ] SHA-256 anotado en el registro del cutover.
- [ ] Restore verificado en una base desechable (`pg_restore --exit-on-error`).
- [ ] `node --import tsx scripts/audit-schema.ts` contra el restore: fingerprint
      idéntico al origen (`sha256:…`, tablas/funciones/triggers/índices).
- [ ] Conteos de negocio comparados (orders, order_items, inventory,
      inventory_movements, pickup_codes) y sin diferencias.
- [ ] Backup **fuera** del volumen de Railway (R2/S3 o disco cifrado del
      responsable). Un backup en el mismo volumen no protege de un volumen
      perdido.
- [ ] Retención mínima: 30 días (ver §12).

Si el cutover es de **datos de Producción**, el dump se toma de Neon y se
restaura en Railway. Si Producción sigue vacía (estado actual conocido), se
documenta esa condición en `PRODUCTION_BASELINE.md` y no se inventan datos.

---

## 3. Freeze de cambios

Ventana sugerida: **60–90 minutos** (más si hay migraciones largas).

1. Anunciar el freeze en el canal del equipo con hora de inicio y fin.
2. `git tag pre-cutover-YYYY-MM-DD` sobre el SHA aprobado.
3. Prohibido: merges a `main`, deploys a Vercel, cambios de variables,
   migraciones manuales, cambios de DNS.
4. Poner la app en **modo lectura** si hay escrituras concurrentes:
   - deshabilitar creación de pedidos (`POST /api/orders`) a nivel de proxy o
     mantenimiento;
   - deshabilitar el cron de Railway/Vercel durante la ventana;
   - avisar en la UI si el negocio lo requiere.
5. Confirmar que no hay jobs en vuelo:
   `railway logs --service cron --environment staging` (última corrida OK).
6. Registrar el HEAD congelado y el SHA del backup.

- [ ] Freeze anunciado y respetado.
- [ ] Tag creado.
- [ ] Escrituras detenidas.
- [ ] Cron detenido o sin corridas en vuelo.
- [ ] HEAD y backup registrados.

---

## 4. Variables

### 4.1 Variables del servicio `web`

Cargar/actualizar **sin pegar valores en el chat ni en el repo**:

```bash
railway variables --service web --environment staging \
  --set 'APP_ENV=staging' \
  --set 'DB_DRIVER=pg' \
  --set 'NIXPACKS_NODE_VERSION=22'
```

- [ ] `APP_ENV` correcto (`staging` ahora; `production` solo en el cutover real).
- [ ] `BETTER_AUTH_URL`/`NEXT_PUBLIC_SERVER_URL` con el dominio exacto que se
      usará (sin barra final).
- [ ] `BETTER_AUTH_SECRET` ≥ 32 caracteres, **distinto** del de staging.
- [ ] `PLATFORM_ADMIN_SECRET` ≥ 32 caracteres, distinto del de staging.
- [ ] `ADMIN_API_SECRET` ≥ 16 caracteres (ideal ≥ 32).
- [ ] `ALLOW_ADMIN_TOKEN_FALLBACK` **no** definido en Producción (la sesión real
      es obligatoria).
- [ ] `MERCADOPAGO_*` sin cambios respecto de lo que ya usa Producción; no se
      piden credenciales nuevas ni se registra webhook en este cutover (Mercado
      Pago de pedidos sigue congelado).
- [ ] `ONLINE_PAYMENTS_ENABLED` **no** definida (o `0`): el cobro online sigue
      congelado y no es GO/NO-GO de este cutover.
- [ ] Correo real: seguir `EMAIL_RESEND_SETUP.md` (dominio verificado, SPF, DKIM,
      DMARC y prueba con un buzón real). Sin eso, el correo sale degradado.
- [ ] Datos de contacto confirmados en `config/business.ts`: correo de atención,
      correo legal (`juancallerosales19@gmail.com`) y WhatsApp (+51 979 363 149).
      Las variables de entorno son solo override, no duplicación.
- [ ] Ninguna credencial live en staging; ninguna credencial de staging en
      Producción.
- [ ] `VERCEL_ENV` **no** definido en Railway (el código usa `APP_ENV`).
- [ ] `RAILWAY_PUBLIC_DOMAIN` la provee la plataforma; no se fija a mano salvo
      dominio custom.

### 4.2 Auditoría de rotación de secretos (sin valores)

Todos los secretos que tocaron staging, QA o un preview deben rotarse **antes**
de que Producción los use. La lista es de nombres: los valores no se leen, no se
copian y no se pegan en documentos.

> Excepción: las credenciales de **Mercado Pago de pedidos no se rotan** en este
> cutover. Están congeladas y cualquier cambio en la app de Mercado Pago queda
> para la fase de descongelamiento, con su propia autorización.

| Variable | Por qué rotarla | Cuándo | Cómo |
|---|---|---|---|
| `BETTER_AUTH_SECRET` | Firmó sesiones de staging/QA; invalida sesiones al rotar | Antes del cutover | `openssl rand -base64 48` en el gestor de secretos → actualizar → desplegar → forzar re-login |
| `PLATFORM_ADMIN_SECRET` | Firmó cookies de Platform Admin de staging | Antes del cutover | Igual; las cookies viejas dejan de valer |
| `ADMIN_API_SECRET` | Token compartido usado por scripts/CI | Antes del cutover | Rotar y actualizar CI/automatización; en Producción la sesión es obligatoria |
| `KIOSK_ACCESS_CODE` | Clave de terminal de staging | Antes del cutover | Rotar; reconfigurar tablets |
| `CRON_SECRET` | Autoriza ambos jobs de cron | Antes del cutover | Rotar en `web` y `cron` en la misma operación |
| `DATABASE_URL` / `POSTGRES_URL_NON_POOLING` | Credenciales de base compartidas con QA | Al crear la base de Producción | Usuario/rol nuevo y contraseña nueva; no reutilizar el de staging |
| `PAYLOAD_SECRET` | Firma del CMS | Antes del cutover | Rotar; invalida sesiones del admin de Payload |
| `MERCADOPAGO_ACCESS_TOKEN` | Token de prueba en staging | **No aplica** (congelado) | No se toca; al descongelar se emiten credenciales nuevas y no se reutilizan las de test |
| `MERCADOPAGO_WEBHOOK_SECRET` | Secreto de la app de prueba | **No aplica** (congelado) | No se toca; al descongelar se registra el webhook con el dominio activo |
| `RESEND_API_KEY` | Clave de correo usada en staging | Antes de enviar correo real | Crear clave con dominio verificado y permisos mínimos |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | Credenciales de storage si se usaron en staging | Antes del cutover | Token R2 nuevo, alcance solo al bucket |
| `SUPABASE_SERVICE_ROLE_KEY` | Legacy notes/listas | Si se conserva la función | Rotar en Supabase; no exponer en cliente |
| `PLATFORM_ADMIN_EMAILS` | Allowlist de bootstrap | Revisar, no es secreto | Dejar solo correos del negocio; el resto debe estar en `platform_admins` |

- [ ] Tabla revisada y cada fila marcada como rotada o "no aplica".
- [ ] Los secretos viven en el gestor de Railway/Vercel, nunca en `.env` versionado.
- [ ] Nadie copió valores a tickets, capturas, logs ni a este runbook.

---

## 5. Migraciones

Orden vigente: `001` … `022`. Cada una es idempotente donde corresponde.

```bash
# 1. Ver el estado sin escribir.
node --import tsx scripts/audit-schema.ts

# 2. Aplicar por nombre, una o varias, con ON_ERROR_STOP.
node --import tsx scripts/apply-migrations.ts 019 020 021 022

# 3. Volver a auditar: fingerprint y marcadores.
node --import tsx scripts/audit-schema.ts
```

Reglas:

- **Nunca** aplicar en Producción sin `APP_ENV` correcto y sin backup verificado.
- `scripts/apply-migrations.ts` exige `--allow-production` para ese entorno.
- Una migración por PR/commit pequeño; si falla, se corrige el SQL y se vuelve a
  correr, no se edita a mano la base.
- `022_rls_tenant_isolation.sql` activa RLS: verificar que la app use el rol
  correcto y que los tests de aislamiento pasen **después** de aplicarla.
- Las migraciones `down` existen solo para 001–007; para 008–022 el rollback es
  restaurar el backup, no improvisar un `DROP`.

Verificación mínima:

- [ ] `audit-schema` reporta 001–022 `OK`.
- [ ] Fingerprint anotado antes/después.
- [ ] `payment_webhook_events`, `contact_messages`, `stores`, `plans`,
      `subscriptions`, `platform_admins`, `email_outbox` existen.
- [ ] `SELECT count(*)` de tablas críticas coincide con el backup.
- [ ] `tests/rls.integration.test.ts` y `tests/tenant-guards.integration.test.ts`
      verdes contra un clon.

---

## 6. Deploy

```bash
export GIT_COMMIT_SHA=$(git rev-parse HEAD)
railway up --service web --environment staging
railway logs --service web --environment staging
curl -sS https://<host>/api/health | jq '{ok, environment, commit, build, database}'
```

- [ ] `GIT_COMMIT_SHA` = HEAD congelado (el deploy por archivo no lo inyecta solo).
- [ ] Build `SUCCESS`.
- [ ] `/api/health` → 200, `commit` = HEAD, `database.reachable=true`,
      `database.type=pg`.
- [ ] Sin errores nuevos en logs (500, `auth_db_not_configured`,
      `platform_db_not_configured`).
- [ ] El cron no arranca hasta que el health esté verde.
- [ ] Si el build vuelve a quedar pausado por Railway, **detener** y esperar:
      no reintentar en bucle ni cambiar de plan.

---

## 7. Dominio / DNS (futuro)

**No se ejecuta en esta fase.** El dominio sigue en Vercel hasta el GO.

Cuando se autorice:

1. Bajar el TTL del registro a 300 s **24 h antes**.
2. Crear el dominio custom en Railway y verificar el certificado.
3. Cambiar el registro (A/CNAME según indique Railway) en el proveedor de DNS.
4. Verificar propagación: `dig +short umantai.com`, `curl -I https://umantai.com`.
5. Mantener Vercel resolviendo por si hace falta volver atrás.
6. Actualizar `NEXT_PUBLIC_SERVER_URL`, `NEXT_PUBLIC_SITE_URL` y
   `BETTER_AUTH_URL` **antes** de cambiar el DNS, para que los enlaces y las
   cookies no queden con el host viejo. `MERCADOPAGO_BACK_URL_BASE` no se toca
   mientras Mercado Pago siga congelado.
7. Volver a subir el TTL a 3600 s después de 48 h estables.

- [ ] TTL bajo aplicado con antelación.
- [ ] Certificado emitido y válido.
- [ ] (Sólo al descongelar) el webhook de Mercado Pago apunta al dominio nuevo;
      no se modifica en este cutover.
- [ ] Correo (SPF/DKIM) del dominio nuevo verificado si se envía desde ahí.

---

## 8. Smoke post-deploy

Automatizado:

```bash
SMOKE_BASE_URL=https://<host> node scripts/security-smoke.mjs
SMOKE_BASE_URL=https://<host> node scripts/load-baseline.mjs --requests=20 --concurrency=5
node scripts/smoke-billing.mjs   # requiere ADMIN_API_SECRET y CRON_SECRET
node --import tsx scripts/trigger-expire-reservations.mjs
```

Manual/HTTP (200 esperado): `/`, `/products`, `/products/<slug>`, `/<store>`,
`/<store>/p/<slug>`, `/cart`, `/list`, `/contacto`, `/legal`,
`/legal/{privacidad,terminos,reembolsos,cookies,aviso-legal}`, `/sitemap.xml`,
`/robots.txt`, `/api/health`.

Seguridad:

- [ ] `/api/admin/*` sin cookie/token → 401/503, nunca 200.
- [ ] `/api/orders` con `Origin` ajeno → 403.
- [ ] CSP presente, `script-src` con nonce y sin `unsafe-inline`.
- [ ] `/admin`, `/debug`, `/kiosk`, `/pedido/`, `/cart`, `/list` bloqueados en
      `robots.txt`.
- [ ] `/pedido/<token>` de un pedido real muestra estado y PIN correctos.
- [ ] Cron: reservas vencidas liberadas; billing idempotente.

El detalle funcional completo está en `FINAL_QA_CHECKLIST.md`; no se declara GO
sin ese checklist cerrado.

---

## 9. Rollback

### 9.1 Si el problema es el deploy (código)

```bash
railway redeploy --service web --environment staging   # vuelve a la imagen anterior
# o
git checkout <SHA-anterior> && GIT_COMMIT_SHA=<SHA-anterior> railway up --service web
```

Verificar `/api/health` con el `commit` anterior y repetir el smoke mínimo.

### 9.2 Si el problema son datos/migraciones

1. Detener escrituras y cron.
2. Restaurar el dump verificado en una base nueva (`restore_drill`), **no**
   encima de la base rota.
3. Apuntar `DATABASE_URL`/`POSTGRES_URL_NON_POOLING` a la base restaurada.
4. Verificar fingerprint y conteos.
5. Recién entonces volver a habilitar escrituras.

### 9.3 Si el problema es el dominio

- Revertir el registro DNS al valor anterior (Vercel) y subir el TTL.
- Mantener Railway vivo para diagnóstico; no borrarlo durante la ventana.

### 9.4 Si el problema es Mercado Pago

Mercado Pago de pedidos está fuera del alcance mientras siga congelado: un fallo
suyo **no** obliga a rollback del cutover, porque ningún paso de este runbook
depende de un pago.

- No se toca la cuenta ni el webhook live sin aprobación.
- Pausar pagos (feature flag / retirar botón) y seguir con el flujo manual
  acordado. El stock reservado se libera por cron.

- [ ] Rollback probado al menos una vez en staging (redeploy y restore drill).
- [ ] Tiempo objetivo de rollback: **≤ 30 min** para código, **≤ 2 h** para datos.

---

## 10. Criterios GO / NO-GO

**GO** solo si se cumple todo:

- [ ] Preflight local verde y HEAD congelado.
- [ ] Backup verificado con restore y fingerprint.
- [ ] Migraciones 001–022 aplicadas y auditadas.
- [ ] `/api/health` con commit correcto y base reachable.
- [ ] `FINAL_QA_CHECKLIST.md` cerrado. Los ítems de Mercado Pago están marcados
      como **congelados externamente** y no condicionan el GO.
- [ ] Security smoke y load baseline dentro de los umbrales acordados.
- [ ] Rollback probado.
- [ ] Ventana de convivencia definida y aceptada por el negocio.
- [ ] Responsable del cutover y del rollback nominados.
- [ ] Datos legales del titular completos (`isLegalReadyForLaunch()` = `true`):
      razón social, RUC, domicilio fiscal y jurisdicción.
- [ ] Libro de Reclamaciones virtual implementado y visible (ver
      `LIBRO_RECLAMACIONES.md`).

**NO-GO** si ocurre cualquiera (Mercado Pago **no** es criterio de NO-GO
mientras siga congelado):

- Builds de Railway pausados o inestables.
- Backup sin restore verificado.
- Migración fallida o fingerprint distinto sin explicación.
- `/api/health` sin base o con commit equivocado.
- Falla de aislamiento entre tiendas (RLS/tenant guards).
- Sesión de Platform Admin accesible sin cuenta autorizada.
- Cron con `CRON_SECRET` inválido o primera corrida fallida.
- Cualquier 500 nuevo en rutas públicas.
- No hay ventana de rollback acordada.
- `isLegalReadyForLaunch()` sigue en `false` (las páginas legales muestran
  `[PENDIENTE: …]`).
- No existe Libro de Reclamaciones virtual accesible y funcional.

---

## 11. Ventana de convivencia Vercel / Railway

Objetivo: poder volver atrás sin perder datos ni pedidos.

| Fase | Duración | Vercel | Railway | Datos |
|---|---|---|---|---|
| A — Ensayo | 1–3 días | Producción activa | staging con smoke | staging propio |
| B — Cutover | 60–90 min | congelado, sin escrituras | recibe tráfico | base de Producción restaurada |
| C — Convivencia | 7–14 días | standby, DNS TTL bajo | Producción | única fuente: Railway |
| D — Cierre | día 30 | se archiva (no se borra) | Producción | backups retenidos |

Reglas de convivencia:

- **Una sola** base recibe escrituras. Nunca dual-write.
- Vercel queda en standby (sin cron, sin webhooks duplicados).
- El webhook de Mercado Pago apunta a **un** host; como está congelado no se
  cambia en el cutover. Al descongelarlo, verificar que el host anterior no siga
  recibiendo.
- Los correos y enlaces usan el dominio que esté activo.
- Si hay que volver a Vercel, se restaura el último backup de Railway en Neon y
  se documenta la pérdida de datos de la ventana.

- [ ] Responsable de alternar DNS/webhook nominado.
- [ ] Prueba de ida y vuelta (Railway → Vercel) al menos una vez en staging.
- [ ] Fecha de cierre de la convivencia acordada.

---

## 12. Qué NO borrar durante 30 días

No se elimina nada de esta lista hasta que el negocio firme el cierre:

- Proyecto y servicios de **Vercel** (incluidos deployments y logs).
- Base **Neon** y sus ramas/branches de Producción.
- Proyecto **Railway**, entornos `staging` y `production`, servicios `web`,
  `Postgres17`, `cron` y el `Postgres` PG18 con las copias de QA.
- Volúmenes de PostgreSQL (`postgres17-volume`) y cualquier snapshot.
- Backups (`backups/*.dump`), artefactos de auditoría (`audit-*.json`) y
  fingerprints.
- Proyecto/credenciales de **Mercado Pago** y su historial de webhooks.
- Cuenta de **Resend**, dominio verificado y plantillas.
- Buckets R2/S3 y objetos de imágenes de tiendas.
- Repositorio GitHub, ramas `main` y `feat/railway-staging`, tags
  `pre-railway-2026-10-19` y `pre-cutover-*`.
- Registros DNS y certificados.
- Logs de Railway/Vercel de la ventana de cutover.

- [ ] Lista revisada y firmada al día 30.
- [ ] Borrado posterior con backup final y aprobación escrita.

---

## 13. Registro del cutover (completar al ejecutar)

| Campo | Valor |
|---|---|
| Fecha/hora UTC | |
| Responsable | |
| HEAD desplegado | |
| Build ID | |
| Backup (SHA-256) | |
| Fingerprint pre/post | |
| Migraciones aplicadas | |
| `/api/health` commit | |
| Smoke seguridad | |
| Load baseline (p95) | |
| GO/NO-GO | |
| Incidentes | |
| Rollback ejecutado | sí / no |
