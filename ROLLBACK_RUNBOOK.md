# Rollback runbook — Umantai

**Estado:** procedimiento escrito, **NO ejecutado**.
**Alcance:** volver de un despliegue/DB nueva a la última versión estable conocida
sin perder pedidos, stock ni pagos.
**Fecha:** 2026-10-19 · **Rama de referencia:** `feat/railway-staging`

> Regla de oro: **primero se detienen las escrituras, después se cambia el
> tráfico**. Un rollback de código contra una base ya migrada puede escribir
> datos con un esquema que la versión anterior no entiende.

---

## 1. Cuándo activar rollback

Activar si **cualquiera** de estas condiciones se cumple en el entorno afectado:

| Señal | Umbral / evidencia |
|---|---|
| Checkout roto | `POST /api/orders` falla de forma sostenida (>5 min) con 5xx |
| Pagos inconsistentes | pagos aprobados sin pedido `confirmed`, o pedidos confirmados sin movimiento de stock |
| Stock negativo o sobre-reservado | `inventory.quantity_reserved > quantity_on_hand` o disponible < 0 |
| Migración destructiva/regresiva | fingerprint inesperado, funciones faltantes, error `column/relation does not exist` |
| Deploy con error de arranque | `/api/health` 503 por >5 min o crash loop |
| Incidente de seguridad | secreto expuesto, acceso no autorizado a admin/kiosco |
| Datos corruptos | conteos que bajan sin cancelación, pedidos duplicados masivos |

No activar por: un deploy lento, un warning de lint, o un fallo aislado que ya
tuvo reintento exitoso.

---

## 2. Detener escrituras (en este orden)

1. **Congelar el cron** para que no libere reservas ni cambie estados:
   ```bash
   # staging (Railway): deshabilitar el schedule del servicio cron
   railway cron list --service cron --environment staging
   # y en el dashboard: Service → Settings → Cron Schedule → quitar schedule
   ```
   En Vercel: deshabilitar el cron job del proyecto (Project → Settings → Cron Jobs).
2. **Bajar la app de escritura**:
   - Railway: escalar el servicio `web` a **0 réplicas** desde el dashboard
     (Service → Settings → Scale). El volumen y la DB NO se tocan.
     **No usar `railway down`**: ese comando *elimina* el deployment actual; es
     reversible con un redeploy, pero no es la forma de pausar el servicio.
   - Vercel: pausar el proyecto o aplicar Instant Rollback (paso 3) antes de
     seguir aceptando tráfico.
3. **Modo read-only de la base** (sólo si la app sigue arriba y hay riesgo de
   escritura concurrente):
   ```sql
   ALTER DATABASE <db> SET default_transaction_read_only = on;
   -- revertir: ALTER DATABASE <db> SET default_transaction_read_only = off;
   ```
   Afecta sesiones nuevas; las conexiones del pool pueden seguir escribiendo
   hasta reciclarse. Si se usa un rol de app dedicado, además:
   `REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public FROM <rol>;`
   (registrar el estado previo antes de revocar).
4. Confirmar que no entran escrituras: revisar logs de `POST /api/orders`,
   webhooks de pago y `/api/kiosk/*` durante 2 minutos.

---

## 3. Repuntar al entorno anterior

### Railway (staging)
1. Identificar el deployment estable:
   ```bash
   railway status                      # deployment actual
   railway deployment list --service web --environment staging --json
   ```
2. Redesplegar **la imagen anterior** (no rebuild):
   ```bash
   railway redeploy --service web --environment staging --yes
   # o, desde el dashboard: Deployments → elegir el deployment estable → Redeploy
   ```
3. Si el rollback es de base de datos, **no** se “redeploya” la DB: se restaura
   una copia (ver §6).
4. Volver a habilitar el cron **después** de validar datos.

### Vercel (producción futura)
1. Vercel → Project → Deployments → deployment estable → **Instant Rollback**
   (o `vercel rollback <deployment-url>`).
2. El rollback de Vercel es inmediato y no rebuild: usa el artefacto inmutable.
3. Confirmar que el alias de producción apunta al deployment elegido:
   ```bash
   vercel inspect <deployment-url>
   vercel alias ls
   ```

### Neon / DB de producción
- Si el problema es de datos: crear una **branch** desde el punto anterior
  (Neon PITR / branch por timestamp) y repuntar la app a esa branch.
- Si el problema es de esquema: restaurar el dump previo en una DB nueva y
  repuntar la app (nunca “deshacer” migraciones a mano en la DB viva).
- No borrar la branch/DB afectada: queda como evidencia.

---

## 4. Qué ocurre con Railway durante el rollback

- Los deployments son **inmutables**: volver atrás no recompila ni cambia el
  código; se elige otra imagen.
- El **volumen de PostgreSQL persiste** y sigue montado: el rollback de la app
  no revierte datos.
- El servicio `cron` es independiente: si no se deshabilita, sigue ejecutando
  contra la DB actual.
- Las variables de entorno son del servicio/entorno, no del deployment: un
  cambio de variables requiere redeploy para tomar efecto.
- Escalar a 0 detiene el servicio, pero **no** borra el volumen ni la DB.
- `railway down` **elimina** el deployment más reciente (no es un pause);
  evitarlo durante un rollback salvo que se quiera apagar el servicio.

---

## 5. Qué ocurre con Vercel/Neon

- **Vercel:** rollback instantáneo entre deployments ya construidos; el tráfico
  del alias se mueve al anterior. Las variables de entorno no se versionan con el
  deployment: si el incidente fue por una variable, corregirla y redesplegar.
- **Neon:** el compute y las branches siguen existiendo; PITR/branch no modifica
  la branch original. La conexión de la app se cambia por variable de entorno
  (requiere redeploy) o por alias de branch.
- Producción actual (2026-10-19) es un deployment viejo de `main` sobre una base
  sin esquema comercial; el rollback real de la etapa comercial todavía no aplica.

---

## 6. Restaurar datos (si hubo corrupción)

1. Elegir el backup verificado más reciente (`backups/*.dump` + SHA-256).
2. Restaurar en una **DB scratch**, nunca encima de la DB viva:
   ```bash
   createdb -h <host> -U <user> umantai_rollback_scratch
   pg_restore --exit-on-error --no-owner --no-privileges \
     -h <host> -U <user> -d umantai_rollback_scratch backups/qa.dump
   ```
3. Comparar contra el baseline:
   - fingerprint `scripts/audit-schema.ts`
   - conteos por tabla
   - secuencias (`order_number_seq`, `inventory_movements_id_seq`, …)
   - funciones/triggers/índices/constraints
4. Recién entonces repuntar la app a la DB restaurada.
5. Conservar la DB afectada y la restaurada durante 30 días.

---

## 7. Validación después de volver

Checklist mínimo (todo read-only):

- [ ] `/api/health` → 200, `database.reachable=true`, `environment` correcto.
- [ ] `audit-schema` → fingerprint esperado del entorno.
- [ ] Conteos: `orders`, `order_items`, `inventory`, `inventory_movements`,
      `pickup_codes`, `payment_webhook_events`.
- [ ] Secuencias: `order_number_seq` no retrocede ni colisiona; próximos
      `order_number` únicos.
- [ ] Stock: `quantity_reserved >= 0`, `quantity_on_hand >= 0`,
      `available = on_hand - reserved`; sin reservas huérfanas.
- [ ] Estados: pedidos `pending_payment` vencidos se pueden expirar; ningún
      pedido `confirmed` sin pago; ningún `fulfilled` sin movimiento de stock.
- [ ] Pagos: webhooks recientes procesados una sola vez (sin `duplicatePayment`
      inesperado); `payment_webhook_events` sin errores nuevos.
- [ ] Kiosco: PIN válido retira una sola vez; PIN inválido no descuenta stock.
- [ ] Cron deshabilitado durante la ventana y re-habilitado al final.
- [ ] Logs sin 5xx sostenidos durante 15 minutos.

---

## 8. DNS (sólo procedimiento futuro)

> **No ejecutar ahora.** Hoy `umantai.com` está en Vercel y no se toca.

1. Bajar el TTL del registro a 300 s al menos 24 h antes de una ventana de cutover.
2. Cambiar el registro (`A`/`CNAME`) al nuevo destino.
3. Verificar con `dig +short umantai.com` desde varias redes y `curl -I`.
4. Mantener el destino anterior sirviendo durante la ventana.
5. Subir el TTL recién después de 48 h estables.
6. Nunca cambiar DNS y DB en el mismo paso: primero datos, después tráfico.

---

## 9. Responsables y checklist de activación

| Rol | Responsabilidad |
|---|---|
| On-call / incident commander | declara el incidente y decide rollback |
| DB owner | detiene escrituras, restaura y valida datos |
| Deploy owner | mueve tráfico (Railway/Vercel) y confirma versión |
| Negocio / approver | autoriza volver a la versión anterior |

Checklist de activación:

- [ ] Síntoma confirmado con evidencia (logs/métrica), no sospecha.
- [ ] Se identificó el último deployment/DB estable (ID + fecha).
- [ ] Cron detenido y app sin escrituras.
- [ ] Backup disponible y SHA-256 verificado.
- [ ] Rollback ejecutado y healthcheck OK.
- [ ] Validación de datos (§7) completa.
- [ ] Comunicación a negocio y registro del incidente.
- [ ] Cron re-habilitado y monitoreo extendido 24 h.

---

## 10. Qué NO borrar durante los 30 días de convivencia

- Servicios y **volúmenes** de Railway (incluido `Postgres`/PG18 sin uso).
- Deployments anteriores de Railway y Vercel (son el rollback).
- Branches, snapshots y PITR de Neon.
- Backups `backups/*.dump`, `backups/*-schema.dump` y sus hashes.
- DBs `umantai_verify`, `umantai_restore_drill`, `umantai_drill_20261019`,
  `umantai_integration` en staging.
- Logs de webhooks, `payment_webhook_events` y tablas de auditoría.
- Registros DNS y certificados.
- Cualquier tabla/columna “vieja” que el código nuevo ya no lea: primero se
  verifica, después se archiva; nunca se hace `DROP` durante la convivencia.
