/**
 * lib/observability.server.ts — eventos estructurados para los logs.
 *
 * Railway captura stdout/stderr. Se emite UNA línea JSON por evento para poder
 * filtrar por `event` o `level` sin un proveedor externo. Nunca se registran
 * secretos, contraseñas, tokens ni el cuerpo de una request.
 */

type Fields = Record<string, string | number | boolean | null | undefined>;

function emit(level: 'info' | 'warn' | 'error', event: string, fields: Fields = {}): void {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  const line = JSON.stringify(payload);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
}

export function logEvent(event: string, fields?: Fields): void {
  emit('info', event, fields);
}

export function logSecurityEvent(event: string, fields?: Fields): void {
  emit('warn', event, fields);
}

export function logError(event: string, error: unknown, fields?: Fields): void {
  emit('error', event, {
    ...fields,
    error: error instanceof Error ? error.message : String(error),
  });
}

/** Id de correlación inyectado por `proxy.ts`. */
export function requestIdFrom(request: Request): string | null {
  return request.headers.get('x-request-id');
}
