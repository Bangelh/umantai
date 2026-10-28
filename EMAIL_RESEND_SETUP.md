# Correo real con Resend — configuración y validación

**Estado (2026-10-27):** **configurado en staging y validado con envíos reales**.
Railway `staging` → `web` tiene `RESEND_API_KEY` (permiso **solo envío**),
`RESEND_FROM_EMAIL=Umantai <soporte@umantai.com>`, `CONTACT_TO_EMAIL` y
`LEGAL_EMAIL`. La corrida real (§5.7) cerró registro + verificación,
recuperación de contraseña, formulario de contacto y Libro de Reclamaciones con
envíos aceptados por Resend. Los pendientes que quedan son de verificación
externa (bandeja real, panel de Resend) y el cutover a Producción.

**Objetivo:** que UMANTAI pueda enviar correo real antes de abrir al público:

1. verificación de cuenta al registrarse;
2. recuperación de contraseña;
3. aviso del formulario de contacto;
4. (ya existente) aviso al comprador cuando el pedido está listo para retirar.

> El código **ya está integrado** con Resend (`resend@^6.28.1`) y probado en
> staging con el proveedor `test` (`email_outbox`). Lo que falta es la parte
> externa: dominio verificado, registros DNS y la API key. No hace falta tocar
> código para habilitarlo.

---

## 1. Qué ya funciona en el código (verificado)

| Flujo | Archivo | Comportamiento sin Resend |
|---|---|---|
| Verificación de cuenta | `lib/auth.server.ts` + `lib/email.server.ts` | La cuenta se crea; el envío falla cerrado y se registra el evento (nunca se imprime el token) |
| Recuperación de contraseña | `lib/auth.server.ts` (`sendResetPassword`) | Respuesta genérica anti-enumeración; el enlace solo se envía si la cuenta existe |
| Formulario de contacto | `lib/contact.server.ts` | El mensaje se guarda en `contact_messages`; la UI informa que el correo no salió |
| Aviso de pedido listo (PIN) | `lib/notifications.server.ts` | El pedido queda listo; el kiosco muestra la advertencia |

Puntos finos que hay que respetar al configurar:

- **`AUTH_TEST_MODE=1` solo desvía los destinatarios `@umantai.test`**: el resto
  sale por Resend aunque el flag esté encendido. Ya no hay que apagarlo para
  probar con un buzón real (ver §5.8).
- El remitente por defecto es `Umantai <onboarding@resend.dev>`, que **solo
  entrega al correo dueño de la cuenta de Resend**. No sirve para compradores.
- Los enlaces usan `BETTER_AUTH_URL` / `NEXT_PUBLIC_SITE_URL`; deben apuntar al
  host que esté activo en ese momento (staging hoy, dominio final en el cutover).

---

## 2. Lo que falta y de quién depende

| # | Requisito | Quién | Nota |
|---|---|---|---|
| 1 | Cuenta de Resend y acceso al panel | Negocio | Plan gratuito alcanza para el volumen inicial |
| 2 | Dominio propio para enviar (recomendado: subdominio, ej. `send.<dominio>`) | Negocio | Debe ser un dominio que controlen; no usar `resend.dev` |
| 3 | Acceso al DNS del dominio | Negocio / proveedor de hosting DNS | Los registros se cargan una vez |
| 4 | Buzón para `CONTACT_TO_EMAIL` | **Confirmado** | `juancallerosales19@gmail.com` (ya es el valor central) |
| 5 | Buzón para `LEGAL_EMAIL` | **Confirmado** | `juancallerosales19@gmail.com` (ya se muestra en las páginas legales) |
| 6 | API key con permiso **solo envío** | Negocio | Se pega en Railway; nunca en el repo |
| 7 | Aprobar el cambio de variables y la prueba real | Negocio | Último paso antes de abrir |

No se inventa ningún dato: dominio y remitente salen de lo que confirme el dueño.
Los buzones de contacto y legal ya están confirmados y viven en
`config/business.ts`.

> **Gmail no puede ser el remitente.** `RESEND_FROM_EMAIL` debe usar un dominio
> verificado de UMANTAI (por ejemplo `pedidos@send.<dominio>`). El correo de
> atención/legal es el **destinatario** y el contacto publicado, nunca el `FROM`.

---

## 3. Registros DNS (a copiar del panel de Resend)

Resend muestra los valores exactos al agregar el dominio; **esos son los que
manda**, porque cambian según la región y el subdominio elegido. La forma
esperada, usando `send.<dominio>` como subdominio de envío, es:

| Tipo | Nombre | Valor | Para qué |
|---|---|---|---|
| MX | `send.<dominio>` | `feedback-smtp.<region>.amazonses.com` · prioridad 10 | Rebotes (Return-Path) |
| TXT | `send.<dominio>` | `v=spf1 include:amazonses.com ~all` | **SPF**: autoriza a Resend a enviar |
| TXT | `resend._domainkey.send.<dominio>` | `p=<clave pública DKIM>` | **DKIM**: firma criptográfica |
| TXT | `_dmarc.<dominio>` | `v=DMARC1; p=none; rua=mailto:<buzón-de-reportes>;` | **DMARC** (recomendado) |

Notas obligatorias:

- **Un solo registro SPF por nombre.** Si el dominio ya tiene uno (Google
  Workspace, Microsoft 365, etc.), hay que **fusionar** los `include:` en ese
  mismo TXT; dos TXT `v=spf1` invalidan SPF.
- El DKIM se publica en el subdominio que indique el panel (`resend._domainkey…`).
  No editar ni acortar la clave: un carácter de menos invalida la firma.
- **DMARC empieza en `p=none`** con reportes agregados. Cuando SPF y DKIM pasen
  de forma estable (unos días), subir a `p=quarantine` y luego `p=reject`.
  No arrancar en `reject`.
- Si el dominio raíz ya envía correo de negocio, **no** tocar su SPF/DMARC para
  esta integración: usar el subdominio de envío.
- Propagación típica: minutos; hasta 24–48 h en algunos DNS. Resend marca el
  dominio como *Verified* cuando ve los tres registros.

Checklist:

- [ ] Dominio agregado en Resend y región elegida.
- [ ] MX de rebotes publicado.
- [ ] SPF publicado (y fusionado si ya existía).
- [ ] DKIM publicado completo.
- [ ] DMARC en `p=none` con `rua`.
- [ ] Resend muestra **Verified**.

---

## 4. Variables de entorno (servicio `web`)

```env
# API key de Resend (permiso solo envío). Sin ella no sale ningún correo.
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxxxxxx

# Remitente del dominio verificado. NO usar onboarding@resend.dev.
RESEND_FROM_EMAIL=Umantai <pedidos@send.<dominio>>

# Destinatario del formulario de contacto. Ya tiene un valor por defecto en
# config/business.ts; solo hace falta declararla para cambiarlo.
CONTACT_TO_EMAIL=juancallerosales19@gmail.com

# Correo legal mostrado en privacidad/términos/reembolsos y aviso legal.
# También tiene valor por defecto en config/business.ts.
LEGAL_EMAIL=juancallerosales19@gmail.com

# Host activo: los enlaces de verificación/reset salen con este origen.
NEXT_PUBLIC_SITE_URL=https://<host activo>
BETTER_AUTH_URL=https://<host activo>
```

Para la prueba real, además:

```env
# Dejar en 1: el desvío al outbox es solo para @umantai.test.
AUTH_TEST_MODE=1

# Secreto de la corrida E2E (header x-e2e-token). >= 16 caracteres.
E2E_TEST_TOKEN=

# Decisión de producto: exigir verificación en Producción.
# Recomendado 1 una vez que el correo real funcione.
AUTH_REQUIRE_EMAIL_VERIFICATION=1
```

`CONTACT_TO_EMAIL` y `LEGAL_EMAIL` se leen en `config/business.ts`, con el correo
confirmado como valor por defecto: las páginas ya no muestran
`[PENDIENTE: definir correo legal]`. Lo que falta para que salga correo real es
`RESEND_API_KEY` y un `RESEND_FROM_EMAIL` de dominio verificado.

---

## 5. Prueba real (cuando estén la cuenta, el dominio y la key)

Se hace **contra staging**, con un buzón real (no `@umantai.test`), y se repite
en Producción después del cutover.

### 5.1 Verificación de cuenta

1. Registrarse con un correo real (no hace falta tocar `AUTH_TEST_MODE`).
2. Confirmar que el correo llega **desde el dominio verificado** (no desde
   `resend.dev`), en bandeja de entrada (no spam).
3. Confirmar que el correo llega **desde el dominio verificado** (no desde
   `resend.dev`), en bandeja de entrada (no spam).
4. Abrir el enlace: la cuenta queda verificada (`users."emailVerified" = true`)
   y la sesión se inicia.
5. Probar “Reenviar correo de verificación”.

### 5.2 Recuperación de contraseña

1. Pedir recuperación para esa cuenta.
2. Confirmar recepción y que el enlace vence en 1 hora.
3. Cambiar la contraseña y verificar que las sesiones anteriores se revocaron.
4. Pedir recuperación para un correo inexistente: misma respuesta, sin correo
   (anti-enumeración).

### 5.3 Formulario de contacto

1. Enviar un mensaje desde `/contacto` con datos válidos.
2. Confirmar que el aviso llega a `CONTACT_TO_EMAIL` **y** que la fila quedó en
   `contact_messages`.
3. Confirmar que un fallo de Resend no rompe el formulario (el mensaje se guarda
   igual y la UI lo informa).

### 5.4 Aviso de pedido listo (ya existente)

1. Crear un pedido de prueba y marcarlo listo para retirar desde operación.
2. Confirmar el correo al comprador con el PIN.

### 5.5 Libro de Reclamaciones

1. Presentar un reclamo en `/libro-de-reclamaciones` con un correo real.
2. Confirmar que llega la constancia (`RC-…`) y que el enlace de seguimiento
   funciona **sin login** y sin mostrar DNI/teléfono.
3. Responder desde `/admin/reclamaciones` y confirmar que llega la respuesta.
4. Con `RESEND_API_KEY` ausente, comprobar que el reclamo se registra igual y la
   UI/bandeja informa `not_configured` (no finge envío).

### 5.6 Entregabilidad

- [ ] Cabeceras muestran `spf=pass`, `dkim=pass`, `dmarc=pass`.
- [ ] Sin rebotes ni quejas en el panel de Resend.
- [ ] Revisar los reportes DMARC a los 2–3 días.
- [x] Ya no hace falta alternar `AUTH_TEST_MODE`: el correo real y el E2E
      conviven en staging (desvío por destinatario). Ver §5.8.

### 5.7 Corrida real de validación (staging, 2026-10-27)

Ejecutada contra `https://web-staging-6756.up.railway.app` con el candidato
`557f85b`, `AUTH_TEST_MODE` **apagado** desde `web` (variable + redeploy, sin
tocar Producción). Cuenta de prueba: `delivered@resend.dev` (destinatario de
pruebas de Resend: simula entrega sin tocar un buzón ajeno); el aviso de
contacto sí va al buzón real de `CONTACT_TO_EMAIL`.

| Flujo | Resultado |
|---|---|
| Registro | `POST /api/auth/sign-up/email` 200, cookie `__Secure-better-auth.session_token` (HttpOnly, Secure, `SameSite=Lax`) |
| Verificación | enlace `/api/auth/verify-email?token=…` (host de staging) → 302 y `users."emailVerified" = true`; reenvío 200 |
| Recuperación | enlace `/api/auth/reset-password/<token>?callbackURL=%2Frestablecer` → 302 a `/restablecer?token=…`; cambio 200; **reuso 400 `INVALID_TOKEN`**; sesiones previas revocadas; login con la nueva 200 y con la vieja 401 |
| Anti-enumeración | correo inexistente: misma respuesta 200 y **no** genera token |
| Contacto | `POST /api/contact` 200 `delivery=stored`, fila en `contact_messages` con `email_status=sent`; honeypot neutro; payload inválido 400 |
| Libro de Reclamaciones | reclamo 201 `emailStatus=sent`; seguimiento público 200 sin DNI/teléfono/correo y `noindex`; respuesta desde `/admin/reclamaciones` con `emailStatus=sent`; segunda respuesta 409 |
| Logs | 0 apariciones de tokens, enlaces, correos o contenido de mensajes; **0** errores de Resend (`[email] Resend rechazó` / `falló el envío`) |
| Rate limits | recuperación 429 tras 5/min; login 429 en el intento 18; contacto 429 (ver nota) |
| Limpieza | cuenta QA, mensajes, reclamos y outbox de prueba borrados; conteos de staging idénticos a los previos |

**Límites de esta corrida (por el alcance de la API key):**

1. La key es **solo envío**: no se pueden leer `GET /domains` ni
   `GET /emails` (401 `restricted_api_key`). Por eso **no** se pudo confirmar
   `delivered`, rebotes, quejas ni el FROM contra la API: el código confirma
   *envío aceptado* (sin error del proveedor y sin log de rechazo), y
   `delivered`/rebotes hay que verlos en el panel de Resend o con una key de
   lectura.
2. El token de verificación es un **JWT firmado** que solo existe dentro del
   correo (`createEmailVerificationToken`), así que con una key de solo envío no
   se puede releer: el flujo se validó con un token equivalente firmado con el
   mismo secreto y payload. El de recuperación **sí** se recupera de
   `verifications` (`identifier = reset-password:<token>`) y se usó el token real.
3. La recepción en un buzón real (bandeja de entrada, no spam, cabeceras
   SPF/DKIM/DMARC) requiere abrir el buzón de `CONTACT_TO_EMAIL` o el panel.

**Hallazgo operativo (no corregido, el candidato está congelado):**
`app/api/contact/route.ts` llama a `rateLimitGate(..., 'contact', { limit: 5 })`
**y** a `consumeRateLimit(rateLimitKeyFor(request, 'contact'), 5, …)`: las dos
capas usan la misma clave (`contact:<hash(ip)>`) y ventana, así que cada envío
cuenta **dos veces**. Medido en staging: el 3.º envío ya recibe 429 (cupo
efectivo ≈ 2 cada 10 min en vez de 5). `/api/complaints` usa una sola capa y sí
respeta el cupo anunciado. Corrección sugerida: quitar el bloque
`consumeRateLimit` de esa ruta (basta con el `rateLimitGate`).

### 5.8 Test mode (`AUTH_TEST_MODE`) vs. correo real

**Desde esta fase el modo test es POR DESTINATARIO, no global.** Antes, con
`AUTH_TEST_MODE=1` ningún correo salía de la app: una persona real que probaba
`umantai.com` no recibía verificación ni recuperación. Eso obligaba a apagar la
variable a mano para cada prueba humana y a acordarse de volver a encenderla.

| Destinatario con `AUTH_TEST_MODE=1` | Proveedor |
|---|---|
| `@umantai.test` (TLD reservado RFC 2606) | `test`: escribe en `email_outbox` |
| cualquier otro correo | `resend`: envía de verdad |

Además, el endpoint que devuelve los enlaces exige **tres** condiciones:
`AUTH_TEST_MODE=1`, entorno distinto de Producción y header `x-e2e-token` igual a
`E2E_TEST_TOKEN` (comparación en tiempo constante). Sin token responde 404 y
solo puede leer direcciones `@umantai.test`, así que ni un token filtrado sirve
para cosechar enlaces de cuentas reales.

El cupo alto de autenticación (120/min) también quedó atado al token E2E: un
visitante humano conserva 15/min aunque staging tenga el modo test encendido.

| | Valor en staging |
|---|---|
| `AUTH_TEST_MODE` | `1` permanente (el E2E lo necesita) |
| `E2E_TEST_TOKEN` | secreto de 64 hex; lo usa `playwright.config.ts` |
| Correo de personas reales | Resend, siempre |
| `/api/auth/test/outbox` sin token | 404 |

En **Producción** el modo test no puede activarse nunca (`isAuthTestMode()`
devuelve `false` con `APP_ENV=production`), así que allí el correo real es el
único camino. Un `@umantai.test` en Producción falla cerrado (`disabled`): no se
intenta un envío que rebotaría.

---

## 6. Riesgos y rollback

| Riesgo | Mitigación |
|---|---|
| SPF duplicado invalida el dominio | Fusionar en un único TXT antes de verificar |
| DKIM incompleto | Copiar el valor completo del panel; no reescribirlo a mano |
| Correos a spam | Subdominio de envío, DMARC en `none`, probar con Gmail y Outlook |
| `E2E_TEST_TOKEN` filtrado | Solo habilita enlaces de `@umantai.test` y cupos de auth en staging; rotarlo es cambiar la variable y el `.env` local del E2E |
| Remitente no verificado | El envío falla cerrado; la app no se rompe, pero no llega el correo |
| Fuga de la API key | Solo en Railway, permiso de envío, rotarla si se expuso |

**Rollback:** borrar `RESEND_API_KEY`. El registro, el checkout y el formulario
siguen funcionando con degradación explícita; no hay que revertir código. Los
correos de personas reales dejan de salir (fail-closed), los de E2E no cambian.

---

## 7. Orden de ejecución (cuando el dueño dé los datos)

1. Crear cuenta en Resend y agregar el subdominio de envío.
2. Publicar MX, SPF, DKIM y DMARC; esperar *Verified*.
3. Crear la API key (solo envío).
4. Cargar las variables en Railway `staging` → `web` (`RESEND_API_KEY`,
   `RESEND_FROM_EMAIL`, `CONTACT_TO_EMAIL`, `E2E_TEST_TOKEN`).
5. Ejecutar 5.1 → 5.4 con un buzón real.
6. Revisar entregabilidad (5.5).
7. Repetir en Producción **después** del cutover, no antes.
