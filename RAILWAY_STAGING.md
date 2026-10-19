# Railway staging — configuración preparada (NO ejecutada)

**Estado:** preparado, **sin crear servicios, sin desplegar, sin copiar la base y sin DNS**.
**Fecha:** 2026-10-19 · **Commit congelado:** `408a8f5` · **Tag:** `pre-railway-2026-10-19`

> Este documento describe cómo se creará el entorno **cuando se autorice la Fase E**.
> Nada de lo que figura acá se ejecutó. Producción (Vercel + Neon) permanece intacta.

---

## 1. Reglas del entorno

- Staging es un **proyecto/entorno separado** de Producción, con su propia base.
- **No** se reutilizan credenciales live de Mercado Pago.
- **No** se toca `umantai.com`, DNS ni el proyecto Vercel.
- **No** se ejecutan migraciones ni se copia el dump en esta etapa.
- **No** se cambia el driver todavía: el código actual usa `@neondatabase/serverless`
  (HTTP) y **no funcionará contra Railway Postgres** hasta el adaptador de la Fase E.

---

## 2. Topología objetivo

```
Railway Project: UMANTAI
├── Environment: staging
│   ├── web          Next.js 16 · Node 22 · 1 réplica
│   ├── postgres     PostgreSQL 17 · volumen persistente
│   └── cron         servicio programado (cada 15 min)
└── Environment: production    ← NO se crea en esta fase
```

- Región: elegir la más cercana a Perú y a la región de Neon que se use como origen.
- Red: `web` y `postgres` en la **red privada** de Railway.
- Storage: no hace falta hoy (no hay uploads). Sólo volumen para Postgres.

---

## 3. Config-as-code

`railway.json` (raíz) fija:

| Campo | Valor | Motivo |
|---|---|---|
| `build.builder` | `NIXPACKS` | Build estándar de Next.js |
| `build.buildCommand` | `npm ci && npm run build` | Instala desde lockfile y compila |
| `deploy.startCommand` | `npm run start` | `next start` respeta `PORT` de Railway |
| `deploy.healthcheckPath` | `/` | Endpoint existente; `/api/health` queda como pendiente |
| `deploy.healthcheckTimeout` | `120` | Margen para el primer arranque |
| `deploy.restartPolicyType` | `ON_FAILURE` | Reinicio acotado |
| `deploy.restartPolicyMaxRetries` | `5` | Evita bucles infinitos |

No se agrega `.nvmrc` ni `engines` a `package.json`: eso también afectaría el build de
Vercel. La versión de Node se fija en Railway con `NIXPACKS_NODE_VERSION=22`.

---

## 4. Variables del servicio `web` (staging)

Los valores entre `<>` son placeholders. **Nunca** se commitean secretos.

| Variable | Valor staging | Obligatoria | Nota |
|---|---|---|---|
| `APP_ENV` | `staging` | Sí | Señal primaria de entorno |
| `NIXPACKS_NODE_VERSION` | `22` | Sí | Next 16 requiere Node ≥ 20.9 |
| `POSTGRES_URL_NON_POOLING` | `${{Postgres.DATABASE_URL}}` | Sí | Referencia interna de Railway |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Sí | Fallback y Payload |
| `PAYLOAD_SECRET` | `<openssl rand -hex 32>` | **Sí, también en build** | Sin él, `next build` falla en Railway |
| `ADMIN_API_SECRET` | `<32+ chars aleatorios>` | Sí | Panel y APIs de admin |
| `KIOSK_ACCESS_CODE` | `<10+ chars aleatorios>` | Sí | Kiosco |
| `CRON_SECRET` | `<aleatorio>` | Sí | Autorización del cron |
| `COMMERCE_RESERVATION_TTL_MINUTES` | `30` | No | Default del código |
| `MERCADOPAGO_ACCESS_TOKEN` | `<token de la app de PRUEBA>` | Para probar pagos | Nunca credenciales live |
| `MERCADOPAGO_WEBHOOK_SECRET` | `<secreto de la app de PRUEBA>` | Para probar webhook | Sin él → 503 |
| `MERCADOPAGO_BACK_URL_BASE` | `https://staging.umantai.com` | Recomendada | `back_urls` estables |
| `RESEND_API_KEY` | `<opcional>` | No | Sin ella, el pedido sigue funcionando |
| `RESEND_FROM_EMAIL` | `Umantai <onboarding@resend.dev>` | No | Sólo entrega al dueño de la cuenta |
| `NEXT_PUBLIC_SUPABASE_URL` | `<si se conserva notes/shopping list>` | No | Sin ellas, auth SSR queda inactiva |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `<...>` | No | Idem |
| `SUPABASE_SERVICE_ROLE_KEY` | `<...>` | No | Idem |
| `NEXT_PUBLIC_WHATSAPP_*` | `<opcional>` | No | UI |
| `MP_PAYMENT_SIMULATION` | **no definir todavía** | No | El gate actual exige `VERCEL_ENV=preview`; en Railway no funciona |
| `MP_ORDERS_*` | **no definir** | No | Experimento congelado |
| `VERCEL_ENV` | **no definir** | No | No existe en Railway; el código debe usar `APP_ENV` |

**Nunca** definir en staging: credenciales live de Mercado Pago, `VERCEL_ENV`, secretos
de Producción ni `MP_ORDERS_*`.

---

## 5. PostgreSQL

- Servicio gestionado **PostgreSQL 17** (misma major que el origen).
- Volumen persistente adjunto.
- `DATABASE_URL` de Railway apunta a la red privada (`postgres.railway.internal`),
  **sin SSL**. Si se usa el proxy público, agregar `?sslmode=require`.
- Verificar al crear: `server_version`, timezone (`UTC`), `max_connections` y extensiones
  (`plpgsql`).
- El esquema es estándar: no requiere extensiones adicionales.
- **No asumir PITR.** Programar `pg_dump` a R2/S3 y verificar restauración.

---

## 6. Cron

`vercel.json` no se lee en Railway. El endpoint sigue existiendo:

```
GET /api/cron/expire-reservations
Authorization: Bearer <CRON_SECRET>
```

Plan: un servicio programado cada 15 minutos que llame a la URL interna de `web` con
`CRON_SECRET`. Se configura recién en la Fase E/F; no en esta fase.

---

## 7. Orden de ejecución futuro (no ejecutado)

1. Crear proyecto/entorno `staging` en Railway.
2. Crear el servicio PostgreSQL 17 y su volumen.
3. Cargar variables del servicio `web` (sin secretos live).
4. Tomar el backup de la base origen y verificar la restauración (Fase A).
5. Copiar la base a staging y correr `audit-schema` en origen y destino (Fases C–D).
6. Aplicar 004–007 **sobre la copia** y volver a comparar el fingerprint.
7. Crear `release/railway-staging` e introducir el adaptador de driver (Fase E).
8. Recién entonces desplegar `web` y conectar la app.
9. Smoke tests y checklist de QA (Fase F–G).

Cada paso requiere autorización explícita. Este documento no ejecuta ninguno.

---

## 8. Pre-flight obligatorio antes de conectar la app

- [ ] Driver `pg` implementado y probado (el actual es HTTP de Neon).
- [ ] `PAYLOAD_SECRET` presente en build y runtime.
- [ ] `APP_ENV=staging` (no `VERCEL_ENV`).
- [ ] Esquema reconciliado: 001–007 presentes y verificados con fingerprint.
- [ ] Gates QA migrados de `VERCEL_ENV` a `APP_ENV` (simulación, cleanup, captura).
- [ ] `vercel.json` headers movidos a `next.config.ts`.
- [ ] Cron de Railway con `CRON_SECRET`.
- [ ] Backup verificado y runbook de rollback escrito.
- [ ] Correo con dominio verificado (o aceptar que no llega al comprador).
- [ ] Ninguna credencial live de Mercado Pago en staging.

---

## 9. Rollback

- Vercel + Neon **no se tocan** durante toda la migración.
- El dominio sigue apuntando a Vercel hasta el cutover (Fase H).
- Si staging falla, se destruye el entorno staging; Producción no se entera.
- En un cutover futuro: TTL de DNS bajo, ventana de congelamiento de escrituras y
  restauración desde el dump verificado.

---

## 10. Qué NO se hizo

- No se creó ningún proyecto, servicio ni base en Railway.
- No se copió ni se dumpeó ninguna base.
- No se desplegó la app.
- No se cambió el driver.
- No se aplicaron migraciones.
- No se tocó DNS, Vercel, Neon ni Mercado Pago.
- No se movió código.
