/**
 * lib/observability.server.ts — eventos estructurados para los logs.
 *
 * Railway captura stdout/stderr. Se emite UNA línea JSON por evento para poder
 * filtrar por `event` o `level` sin un proveedor externo.
 *
 * CAMPOS DE UNA REQUEST: `request_id`, `environment`, `route`, `method`,
 * `duration_ms`, `result` y `error_category`. Nunca se registran contraseñas,
 * tokens, cookies, `Authorization` completo, documentos, geolocalización exacta
 * ni credenciales: `sanitizeFields` descarta esas claves antes de serializar.
 */

import { resolveRuntimeEnvironment } from './runtime-environment.server';

type FieldValue = string | number | boolean | null | undefined;
type Fields = Record<string, FieldValue>;

/**
 * Claves que JAMÁS se serializan. Se comparan en minúsculas por substring para
 * cubrir variantes (`accessToken`, `doc_number`, `x-admin-token`…).
 */
const SENSITIVE_KEY_PATTERNS = [
  'password',
  'passwd',
  'token',
  'secret',
  'cookie',
  'authorization',
  'credential',
  'apikey',
  'api_key',
  'document',
  'docnumber',
  'doc_number',
  'latitude',
  'longitude',
  'geolocation',
  'coords',
];

const MAX_STRING = 300;

export function sanitizeFields(fields: Fields = {}): Fields {
  const clean: Fields = {};
  for (const [key, value] of Object.entries(fields)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_KEY_PATTERNS.some((pattern) => lower.includes(pattern))) continue;
    if (typeof value === 'string') {
      clean[key] = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

function environmentName(): string {
  try {
    return resolveRuntimeEnvironment().name;
  } catch {
    return 'unknown';
  }
}

function emit(level: 'info' | 'warn' | 'error', event: string, fields: Fields = {}): void {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    environment: environmentName(),
    ...sanitizeFields(fields),
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

/**
 * Categoría segura de error: se registra el TIPO, nunca el mensaje crudo de la
 * base (puede incluir valores de filas) ni el stack en producción.
 */
export function classifyError(error: unknown): string {
  if (!error || typeof error !== 'object') return 'unknown';
  const candidate = error as { code?: unknown; name?: unknown };
  const code = typeof candidate.code === 'string' ? candidate.code : '';

  // Códigos SQLSTATE frecuentes.
  if (code === '23505') return 'conflict_unique';
  if (code === '23503' || code === '23514') return 'constraint_violation';
  if (code === '42501') return 'forbidden_rls';
  if (code === '40001' || code === '40P01') return 'retryable_conflict';
  if (code.startsWith('08') || code === 'ECONNREFUSED' || code === 'ETIMEDOUT') {
    return 'database_unavailable';
  }
  if (candidate.name === 'TenancyError' || code === 'not_authenticated') return 'auth';
  if (code === 'rate_limited') return 'rate_limited';
  if (candidate.name === 'CatalogError' || code === 'invalid_input') return 'validation';
  return 'internal';
}

export function logError(event: string, error: unknown, fields?: Fields): void {
  emit('error', event, {
    ...fields,
    errorCategory: classifyError(error),
    // En producción solo el nombre del error; el mensaje puede traer datos.
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage:
      process.env.NODE_ENV === 'production' && environmentName() === 'production'
        ? undefined
        : error instanceof Error
          ? error.message
          : String(error),
  });
}

export interface RequestLog {
  request: Request;
  route: string;
  status: number;
  durationMs: number;
  error?: unknown;
}

/**
 * Una línea por request atendida. `result` es estable (`ok` / `error`) para
 * alertas simples; el detalle va en `errorCategory`.
 */
export function logRequest({ request, route, status, durationMs, error }: RequestLog): void {
  emit(status >= 500 ? 'error' : 'info', 'request_completed', {
    requestId: request.headers.get('x-request-id'),
    route,
    method: request.method,
    status,
    durationMs: Math.max(0, Math.round(durationMs)),
    result: status < 400 ? 'ok' : 'error',
    errorCategory: error ? classifyError(error) : status >= 400 ? 'http_error' : undefined,
  });
}

/** Envuelve un handler de ruta para medir duración y emitir el log. */
export function withRequestLogging<T extends (request: Request, ...rest: never[]) => Promise<Response>>(
  route: string,
  handler: T,
): T {
  return (async (request: Request, ...rest: never[]) => {
    const started = performance.now();
    try {
      const response = await handler(request, ...rest);
      logRequest({
        request,
        route,
        status: response.status,
        durationMs: performance.now() - started,
      });
      return response;
    } catch (error) {
      logError('request_failed', error, {
        requestId: request.headers.get('x-request-id'),
        route,
        method: request.method,
      });
      throw error;
    }
  }) as T;
}

/** Id de correlación inyectado por `proxy.ts`. */
export function requestIdFrom(request: Request): string | null {
  return request.headers.get('x-request-id');
}
