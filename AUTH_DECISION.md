# Decisión de autenticación — UMANTAI

**Fecha:** 2026-10-19
**Fase:** Multi-Tenant + Discovery Foundation
**Estado:** implementado y verificado contra PostgreSQL 17 real

---

## 1. Auditoría de la situación previa

| Sistema | Estado encontrado | Uso real |
|---|---|---|
| **Supabase Auth** | `@supabase/ssr` instalado, `middleware.ts` refrescaba la sesión en cada request, página `/debug/supabase` la mostraba. Nunca se creó un usuario ni se protegió una ruta con ella. | **Cero.** No había login de clientes ni de comerciantes. |
| **Neon Auth** | Dependencia `@neondatabase/serverless` presente, pero es el **driver HTTP de Neon**, no Neon Auth. No hay SDK ni configuración de Neon Auth. | **Cero.** |
| **Token compartido `/admin`** | `ADMIN_API_SECRET` + header `x-admin-token`, comparación en tiempo constante. Protege `/admin`, `/api/admin/*`, catálogo y notas. | **Activo.** No identifica personas ni permite roles. |
| **Clave de kiosco** | `KIOSK_ACCESS_CODE` en la tablet de la operaria. | **Activo.** Es un lock de dispositivo. |
| **`localStorage` de carrito/lista** | Sin identidad. | **Activo** (correcto). |

Conclusión: no existía autenticación de usuarios. Había **tres credenciales paralelas** (admin, kiosco, Supabase sin usar) y ninguna resolvía multi-tenancy.

---

## 2. Criterios de decisión

1. Next.js 16 (App Router, route handlers, Server Components) sobre Railway.
2. PostgreSQL propio (Railway) como única fuente de datos.
3. Multi-tenancy: `users` → `store_members` → `stores`.
4. Una identidad puede ser cliente **y** comerciante; no dos tablas de usuarios.
5. Sesiones seguras (cookie HttpOnly, no JWT legible por JS).
6. OAuth posible después sin reescribir el modelo.
7. Evitar un proveedor externo innecesario y costos ocultos.
8. Guest checkout obligatorio: la compra **nunca** exige sesión.

---

## 3. Opciones evaluadas

| Opción | A favor | En contra | Veredicto |
|---|---|---|---|
| **Supabase Auth** | Ya estaba instalado | La app ya migró a PostgreSQL en Railway. Supabase Auth implica un segundo proveedor y una segunda fuente de identidad; el `users.id` de Supabase no es el de la base. Costo y dependencia extra para una necesidad que la propia DB cubre. | **Rechazada** |
| **Auth.js (NextAuth v5)** | Ecosistema Next, OAuth | Sesiones JWT por defecto; para sesiones en DB hace falta adapter + tablas propias. Configuración más pesada para email/contraseña y credenciales. | **No elegida** |
| **Better Auth** | Self-hosted, PostgreSQL nativo, sesiones en DB, cookie HttpOnly, hash de contraseña, plugins de OAuth/2FA/tokens, tipado, sin vendor | Dependencia nueva; hay que mantener el esquema de sus tablas | **ELEGIDA** |
| **Auth propia (scrypt + sessions)** | Cero dependencias | Responsabilidad de seguridad completa (rotación, CSRF, rate limit, OAuth) recae en nosotros. Peor decisión a largo plazo. | **Rechazada** |

---

## 4. Decisión

**Better Auth 1.7.x sobre el PostgreSQL de Railway.**

Razones concretas:

- **Una sola identidad:** `users.id` es la PK que usan `store_members`, `orders.user_id` y el perfil. Cliente y comerciante son la misma fila.
- **Sin segundo proveedor:** no hay Supabase/Neon Auth, ni costos por MAU, ni sincronización de identidades.
- **Sesión segura:** sesión en `sessions` + cookie HttpOnly, SameSite=Lax, Secure en producción. No se guarda ningún token en `localStorage`.
- **OAuth futuro:** el plugin social agrega `auth_accounts` (ya creada) sin cambiar `users`.
- **Guest checkout intacto:** el checkout consulta la sesión, pero no la exige.

---

## 5. Implementación

### 5.1 Tablas (`db/migrations/012_auth.sql`)

| Tabla | Rol |
|---|---|
| `users` | identidad única (email normalizado a minúsculas) |
| `sessions` | sesiones activas (`token`, `expiresAt`, `userId`, IP/UA) |
| `auth_accounts` | credenciales y, a futuro, proveedores OAuth (password hasheada) |
| `verifications` | tokens de verificación / recuperación |
| `customer_profiles` | nombre, teléfono, documento y dirección del cliente |
| `store_members` | `(store_id, user_id, role)` con `role ∈ {owner, admin}` |

Las columnas conservan el camelCase que Better Auth espera (`"emailVerified"`, `"userId"`, `"expiresAt"`); el nombre de tabla se mapea con `modelName` en `lib/auth.server.ts`.

### 5.2 Configuración

- `lib/auth.server.ts`: instancia **perezosa** (no se construye en `next build`), pool `pg` propio, `trustedOrigins` desde `BETTER_AUTH_URL` / `NEXT_PUBLIC_SERVER_URL`.
- `app/api/auth/[...all]/route.ts`: handler de Better Auth.
- Email/contraseña: mínimo 8, máximo 128, auto-login al registrarse, verificación de email **no** obligatoria en esta fase.
- Cookie: `HttpOnly` por defecto; el navegador no puede leer el token.
- Hash: el que aplica Better Auth (scrypt); nunca se guarda la contraseña en claro (verificado en test de integración).

### 5.3 Autorización

No hay RBAC complejo:

- `requireStoreAccess(userId, storeId, minimumRole = 'admin')` es el **único portero** para datos privados de una tienda.
- `owner` y `admin` operan catálogo, pedidos e inventario de **su** tienda.
- Sólo `owner` gestiona miembros (previsto; todavía no hay UI).
- El `storeId` de la URL nunca se confía: se valida contra `store_members` antes de cualquier SELECT/UPDATE.
- Las rutas públicas (buscador, vitrina) sólo devuelven tiendas `active` y productos `visible`.

### 5.4 Migración de secretos compartidos

| Secreto | Antes | Ahora | Destino |
|---|---|---|---|
| `ADMIN_API_SECRET` | todo `/admin` | sigue protegiendo el panel legacy y la **aprobación de tiendas** | reemplazar por rol global `platform_admin` cuando se defina |
| `KIOSK_ACCESS_CODE` | tablet | se mantiene: es un lock de dispositivo, no una persona | hardware key / rol de operador en una fase posterior |
| Supabase Auth | middleware + debug | **retirado** (middleware eliminado; la dependencia queda sólo para notas/listas legacy) | eliminar cuando se migren notas/listas |

No hay login obligatorio en checkout: si hay sesión, `orders.user_id` se completa; si no, queda `NULL` y el pedido funciona igual.

---

## 6. Variables de entorno

```env
BETTER_AUTH_SECRET=<32+ caracteres aleatorios>   # obligatorio en Producción
BETTER_AUTH_URL=https://umantai.com               # staging: URL de Railway
```

Sin `BETTER_AUTH_SECRET` en Producción la autenticación falla cerrada. En staging/desarrollo se usa un secreto efímero con warning para no bloquear deploys, nunca en Producción.

---

## 7. Deuda y riesgos de auth

1. **Sin verificación de email** todavía: un usuario puede registrarse con un correo ajeno. El historial de pedidos usa solo `orders.user_id` (nunca match por email) justamente para no permitir reclamar compras ajenas. Activar verificación antes de abrir registro masivo.
2. **Sin recuperación de contraseña por email**: Resend no está configurado en staging. Better Auth tiene el flujo; falta proveedor de correo y plantilla.
3. **Sin rol de plataforma**: la aprobación de tiendas sigue con `ADMIN_API_SECRET`. Es un puente explícito, no un tercer sistema de usuarios.
4. **Rate limiting**: Better Auth trae límites por defecto; falta revisarlos con tráfico real y agregar captcha si aparece abuso.
5. **Sin OAuth todavía**: la tabla `auth_accounts` ya lo soporta; falta configurar proveedores y consentimiento.
6. **Sin 2FA ni gestión de sesiones/dispositivos**: fase posterior.
7. **`customer_profiles` no se crea al registrarse**: se crea al guardar el perfil. Es intencional (no llenar tablas vacías).

---

## 8. Evidencia

`tests/multi-tenant.integration.test.ts` (PostgreSQL 17 real, efímero):

- sign-up por HTTP → cookie de sesión válida → `getSessionUser` devuelve el usuario;
- sin cookie → `null`;
- sign-in correcto e incorrecto;
- email duplicado rechazado;
- contraseña hasheada (no contiene el texto plano);
- `store_members` con rol `owner`;
- usuario B recibe `store_forbidden` al leer/escribir catálogo, pedidos y analytics de A.
