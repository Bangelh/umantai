# UMANTAI

Marketplace local: buscador de productos por cercanía, vitrina pública por tienda,
pedidos con retiro en tienda y panel de gestión para comerciantes.

## Stack

- **Next.js 16** (App Router) + **TypeScript**
- **PostgreSQL 17** (driver `pg`)
- **Better Auth** para sesiones y contraseñas
- **Payload 3** para el contenido editorial
- **Tailwind CSS 4**
- Despliegue en **Railway** (servicios `web`, `cron` y `Postgres17`)

## Requisitos

- Node.js 20 o superior
- PostgreSQL 17

## Desarrollo local

```bash
npm install
npm run dev
```

La aplicación queda en `http://localhost:3000`.

## Variables de entorno

Las principales:

| Variable | Uso |
| --- | --- |
| `DATABASE_URL` | Conexión a PostgreSQL |
| `BETTER_AUTH_SECRET` | Secreto de sesiones (mínimo 32 caracteres) |
| `NEXT_PUBLIC_SITE_URL` | URL pública del sitio |
| `CRON_SECRET` | Autorización de las tareas programadas |
| `RESEND_API_KEY`, `EMAIL_FROM` | Correos transaccionales |
| `MEDIA_DRIVER` (`db` o `r2`) | Almacenamiento de imágenes |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Solo si `MEDIA_DRIVER=r2` |
| `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET` | Cobro online (opcional) |

## Base de datos

Las migraciones están en `db/migrations` y se aplican en orden numérico:

```bash
for f in db/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done
```

Datos de ejemplo:

```bash
npm run seed:platform
npm run seed:inventory
```

## Verificación

```bash
npm test                # pruebas unitarias
npm run test:integration
npm run lint
npx tsc --noEmit
npm run e2e             # Playwright
```

## Despliegue

Solo staging:

```bash
npm run deploy:staging
npm run health:staging
```

Las tareas programadas se ejecutan desde el servicio `cron`
(`scripts/run-cron.mjs`) contra `/api/cron/expire-reservations` y
`/api/cron/billing`.
