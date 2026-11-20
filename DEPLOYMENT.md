# Despliegue de staging en Netlify + Supabase

Runbook del hosting de staging. **Producción no se toca desde acá.**

- Rama de staging: `feat/railway-staging` → Netlify la publica como *branch deploy*.
- Los branch deploys y deploy previews **no consumen créditos**; solo producción (15 por deploy) y el tráfico.
- Next 16 + Payload 3 corren nativos en el runtime de Next de Netlify. El adaptador se instala solo.

## 1. Cuentas y CLIs

Las tres CLIs se usan con `npx`, no hace falta instalarlas globalmente. Cada login abre el navegador **una vez** y deja la sesión guardada en tu usuario de Windows:

```bash
npx netlify-cli login
npx supabase login
npx wrangler login
```

Verificación:

```bash
npx netlify-cli status     # "Logged in as ..."
npx supabase projects list # tabla, no error de token
npx wrangler whoami        # cuenta y account id
```

## 2. Base de datos (Supabase)

```bash
npx supabase orgs list                     # elegir organización
npx supabase projects create umantai-staging \
  --org-id <ORG_ID> --region sa-east-1 --db-password '<PASSWORD>'
```

Región `sa-east-1` (São Paulo) es la más cercana a Perú.

Credenciales en **Project Settings → Database**:

| Uso | Puerto | Modo | Variable |
|---|---|---|---|
| Runtime (Next, Payload, Better Auth) | 6543 | transaction (pooler) | `DATABASE_URL`, `POSTGRES_URL` |
| Migraciones, seeds, dumps | 5432 | directa o session | `POSTGRES_URL_NON_POOLING` |

Reglas que no se negocian en serverless:

- `PGPOOL_MAX=1` y `PGBETTER_AUTH_POOL_MAX=1`. Cada instancia de función abre una sola conexión; el pooler multiplexa.
- El pooler de transacción **no soporta prepared statements**: el driver `pg` no los usa por defecto, no agregar `statement_cache_size`.
- Las migraciones **nunca** por 6543.

## 3. Imágenes

Dos opciones, y para staging sin tarjeta conviene la primera:

| Driver | Requisitos | Costo |
|---|---|---|
| `db` (por defecto) | ninguno: los binarios van a `media_assets` (`bytea`) | consume los 500 MB de Supabase |
| `r2` | bucket + token de Cloudflare R2 | 10 GB gratis, pero Cloudflare **pide tarjeta** para habilitar R2 |

Arrancar con `MEDIA_DRIVER=db` y pasar a `r2` solo si las imágenes se acercan al límite. R2 se habilita así:

```bash
npx wrangler r2 bucket create umantai-staging
npx wrangler r2 bucket domain add umantai-staging --domain media-staging.umantai.com  # opcional
```

El token de R2 (Access Key ID + Secret) se crea en **R2 → Manage R2 API Tokens** con permiso *Object Read & Write* sobre ese bucket. El código firma SigV4 con Web Crypto (`lib/storage.server.ts`), sin SDK.

## 4. Sitio en Netlify

```bash
npx netlify-cli sites:create --name umantai-staging
npx netlify-cli link            # elegir el sitio recién creado
```

`netlify.toml` ya define build (`npm run build`), publish (`.next`), Node 22 y `APP_ENV=staging` en branch deploys y previews. `APP_ENV=staging` es lo que evita que el staging se indexe y active las salvaguardas de producción.

Variables (una por una, o `--json` para cargar un archivo):

```bash
npx netlify-cli env:set DATABASE_URL 'postgresql://...:6543/postgres?pgbouncer=true&sslmode=require'
npx netlify-cli env:set POSTGRES_URL_NON_POOLING 'postgresql://...:5432/postgres?sslmode=require'
npx netlify-cli env:set PGPOOL_MAX 1
npx netlify-cli env:set PGBETTER_AUTH_POOL_MAX 1
npx netlify-cli env:set APP_ENV staging
# La rama conectada (feat/railway-staging) se construye en el contexto *production*,
# así que el valor tiene que existir en ese contexto o el guard de lib/env.ts falla el build.
npx netlify-cli env:set APP_ENV staging --context production --force
npx netlify-cli env:set PAYLOAD_SECRET "$(openssl rand -hex 32)"
npx netlify-cli env:set BETTER_AUTH_SECRET "$(openssl rand -hex 32)"
npx netlify-cli env:set CRON_SECRET "$(openssl rand -hex 32)"
# La URL exacta del branch deploy aparece en Deploys y en `npx netlify-cli status`.
# Patrón: https://<rama-con-guiones>--<sitio>.netlify.app
npx netlify-cli env:set NEXT_PUBLIC_SITE_URL 'https://umantai-staging.netlify.app'
npx netlify-cli env:set BETTER_AUTH_URL 'https://umantai-staging.netlify.app'
npx netlify-cli env:set MEDIA_DRIVER db
```

El inventario completo está en `.env.example`. Las claves de Mercado Pago y Resend se cargan cuando existan las de staging; sin ellas el checkout queda deshabilitado, no roto.

## 5. Esquema y datos

Con `POSTGRES_URL_NON_POOLING` apuntando a Supabase (puerto 5432) y `APP_ENV=staging`:

```bash
# 1. Tablas de la plataforma (27 migraciones idempotentes, en orden)
PREFIXES=$(ls db/migrations | grep -E '^[0-9]{3}_.*\.sql$' | grep -v '\.down\.sql$' | cut -d_ -f1 | sort -u | tr '\n' ' ')
node --import tsx scripts/apply-migrations.ts $PREFIXES

# 2. Tablas de Payload (migrations/20261001_171717_initial)
npm run payload:migrate

# 3. Datos de prueba (idempotentes)
npm run seed:platform
npm run seed:inventory
```

`apply-migrations.ts` se niega a correr con `APP_ENV=production` salvo `--allow-production`. No usar esa bandera acá.

## 6. Primer deploy (build remoto obligatorio)

El build **tiene que correr en Linux**. En Windows, `netlify deploy --build` falla al empaquetar el handler de `proxy.ts`:

```
file:///PROYECTOS/Umantai/C:/PROYECTOS/Umantai/.netlify/edge-functions/.../middleware.js
Cannot find module './webpack-runtime.js'
```

Es un bug de rutas del empaquetador de edge functions, no del código. Por eso el sitio se conecta al repo y construye en Netlify:

1. **Project configuration → Build & deploy → Link repository** → GitHub → `Bangelh/umantai`.
2. Dejar la rama de producción del sitio en `feat/railway-staging` (es un sitio de staging: su "producción" es staging).
3. Push y listo: Netlify ejecuta `npm run build` en Linux e incluye el handler del proxy.

```bash
git push origin feat/railway-staging
```

Verificación:

```bash
curl -s https://umantai-staging.netlify.app/api/health
# {"ok":true,...,"environment":"staging","database":{"reachable":true}}
```

Luego, a mano: `/` (home), `/<tienda>` (vitrina), `/negocio/<storeId>` (panel), `/admin` (bandeja), login del dueño de las tiendas seed.

### Alternativa sin conectar el repo

`.github/workflows/deploy-staging.yml` construye en Ubuntu y despliega con la CLI. Solo necesita `NETLIFY_AUTH_TOKEN` como secreto del repo (Settings → Secrets and variables → Actions), creado en Netlify → User settings → Applications → New access token. Mientras el secreto no exista, el workflow avisa y termina en verde sin desplegar.

## 6b. Estado del staging (2026-11-20)

| Recurso | Valor |
|---|---|
| Sitio | `umantai-staging` · https://umantai-staging.netlify.app |
| Proyecto Supabase | `gkxyacvciyudbmuztzjv` · São Paulo (`sa-east-1`) |
| Pooler | `aws-1-sa-east-1.pooler.supabase.com` (6543 runtime · 5432 migraciones) |
| Esquema | 26 migraciones SQL + `product_overrides`, `categories`, `brands` |
| Datos | 5 tiendas · 18 productos publicados · 63 filas de stock · 1.892 distritos |
| Deploy publicado | `6affe73a4b47df83e907a16a` · build `6affe73a4b47df83e907a168` · commit `fe5e493` |
| Protección | SSO de Netlify desactivado: sin eso el sitio respondía 401 antes de llegar a la app |

El DNS de `umantai.com` sigue apuntando a Railway: staging vive en el subdominio de Netlify hasta que se repunte.

## 7. Cron

`/api/cron/*` exige `Authorization: Bearer <CRON_SECRET>`. Se dispara desde GitHub Actions (`.github/workflows/cron-staging.yml`), no desde scheduled functions de Netlify: esas cobran cómputo y tienen 30 s.

```bash
gh secret set STAGING_URL --body 'https://<branch-deploy>.netlify.app'
gh secret set CRON_SECRET  --body "$(openssl rand -hex 32)"   # el MISMO valor que en Netlify
```

## 8. Dominio (opcional, al final)

- Staging puede quedarse en `*.netlify.app`.
- Para `umantai.com`: en el registrador, apuntar los nameservers a Netlify DNS (o CNAME `www`), y agregar el dominio en **Domain management**. Esto requiere acceso al registrador, que no está en este repo.
- Al cambiar de dominio hay que actualizar `NEXT_PUBLIC_SITE_URL`, `BETTER_AUTH_URL` y la URL de webhook en el panel de Mercado Pago.

## 9. Riesgos conocidos

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Bundle de función > 250 MB sin comprimir | El deploy falla al empaquetar | Excluir binarios de `public/` o moverlos a R2 |
| 300 créditos/mes compartidos | Se agotan y el sitio se suspende hasta el mes siguiente | Staging en branch deploy (0 créditos); vigilar consumo en el panel |
| Supabase Free pausa tras 7 días sin actividad | Primer request tarda ~1 min o falla | El cron diario mantiene la base despierta |
| 500 MB de base | Se llena con imágenes | `db` para staging y volumen bajo; migrar a `r2` (pide tarjeta) si crece |
| Payload 3.85 + Next 16.2.6 | Funciona local; Netlify soporta Next 16 | No actualizar Next sin revisar el peer de `@payloadcms/next` |
| `umantai.com` sigue apuntando a Railway | 404 en el dominio | Repuntar DNS al terminar la validación |

## 10. Rollback

Staging no tiene datos que preservar: borrar el sitio de Netlify y el proyecto de Supabase, o redeployar un commit anterior desde **Deploys → Deploy anterior → Publish deploy**. Producción no se ve afectada en ningún paso.
