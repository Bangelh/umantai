/**
 * lib/runtime-environment.server.ts — decisión ÚNICA sobre el entorno de ejecución.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  POR QUÉ EXISTE
 *
 *  Las reglas de "esto solo puede correr FUERA de Producción" estaban repartidas y
 *  atadas a `VERCEL_ENV` dentro de cada archivo (`isProductionRuntime()` en el
 *  webhook legacy, `VERCEL_ENV === 'preview'` en el diagnóstico y en la simulación
 *  QA). Eso funciona en Vercel y deja de funcionar al mover el runtime (Railway,
 *  contenedores, local): la variable no existe y cada gate termina decidiendo algo
 *  distinto.
 *
 *  Acá hay UNA función, pura y testeable sin entorno real, que responde la única
 *  pregunta que importa: **¿estamos en Producción?** Prioridad:
 *
 *    1. `APP_ENV`    → señal EXPLÍCITA de la app, la única que sobrevive a cualquier
 *                      hosting: `production` | `staging` | `preview` | `development`.
 *    2. `VERCEL_ENV` → entorno real de Vercel (`production` | `preview` | `development`).
 *                      `NODE_ENV` NO sirve en Vercel: la plataforma compila y ejecuta
 *                      TODOS los deployments (Preview incluido) con
 *                      `NODE_ENV=production`.
 *    3. `NODE_ENV`   → último recurso fuera de Vercel.
 *
 *  FAIL-CLOSED: un `APP_ENV` presente pero no reconocido se trata como **Producción**
 *  (se avisa una vez por proceso, sin imprimir el valor). Nunca "si no entiendo la
 *  variable, dejo pasar".
 *
 *  ALCANCE: esta tarea NO cambia ningún gate existente (webhook legacy, diagnóstico,
 *  simulación QA siguen con su lógica actual, intacta). Solo lo usan las rutas nuevas
 *  de `mp-orders`. Cuando se migre el runtime, adaptar acá basta.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Nombre canónico del entorno de ejecución. */
export type RuntimeEnvironmentName = 'production' | 'preview' | 'staging' | 'development';

/** De dónde salió la decisión (para diagnóstico y tests; nunca un valor sensible). */
export type RuntimeEnvironmentSource = 'APP_ENV' | 'VERCEL_ENV' | 'NODE_ENV' | 'default';

/**
 * Mapa de variables de entorno. Es a propósito más laxo que `NodeJS.ProcessEnv` (que
 * exige `NODE_ENV`): permite inyectar combinaciones exactas en los tests sin declarar
 * variables que no se están probando. `process.env` cumple esta forma.
 */
export type RuntimeEnvSource = Readonly<Record<string, string | undefined>>;

export interface RuntimeEnvironment {
  name: RuntimeEnvironmentName;
  /** `true` SOLO si el entorno es Producción real. */
  isProduction: boolean;
  source: RuntimeEnvironmentSource;
}

/**
 * Valores de `APP_ENV` que NO son Producción.
 *
 * `test`/`qa` se mapean a `development` (entorno de desarrollo/pruebas local o CI)
 * y `staging` conserva su nombre para poder distinguirlo en logs.
 */
const APP_ENV_NON_PRODUCTION: Record<string, RuntimeEnvironmentName> = {
  staging: 'staging',
  preview: 'preview',
  development: 'development',
  dev: 'development',
  test: 'development',
  qa: 'development',
};

/** Se avisa UNA sola vez por proceso; nunca se imprime el valor leído. */
let warnedAboutUnknownAppEnv = false;

/** Lee y normaliza una variable del mapa recibido (sin mutar `process.env`). */
function readNormalized(source: RuntimeEnvSource, key: string): string {
  const raw = source[key];
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/**
 * Resuelve el entorno de ejecución. Pura: recibe el mapa de variables, así que se
 * puede probar cada combinación sin tocar el proceso.
 */
export function resolveRuntimeEnvironment(source: RuntimeEnvSource = process.env): RuntimeEnvironment {
  // 1. Señal explícita de la aplicación (independiente del hosting).
  const appEnv = readNormalized(source, 'APP_ENV');
  if (appEnv) {
    if (appEnv === 'production') {
      return { name: 'production', isProduction: true, source: 'APP_ENV' };
    }
    const mapped = APP_ENV_NON_PRODUCTION[appEnv];
    if (mapped) return { name: mapped, isProduction: false, source: 'APP_ENV' };

    if (!warnedAboutUnknownAppEnv) {
      warnedAboutUnknownAppEnv = true;
      console.warn(
        '[runtime-env] APP_ENV tiene un valor no reconocido: se trata como Producción. ' +
          'Usa production | staging | preview | development.',
      );
    }
    return { name: 'production', isProduction: true, source: 'APP_ENV' };
  }

  // 2. Entorno real de Vercel.
  const vercelEnv = readNormalized(source, 'VERCEL_ENV');
  if (vercelEnv === 'production') {
    return { name: 'production', isProduction: true, source: 'VERCEL_ENV' };
  }
  if (vercelEnv === 'preview') {
    return { name: 'preview', isProduction: false, source: 'VERCEL_ENV' };
  }
  if (vercelEnv === 'development') {
    return { name: 'development', isProduction: false, source: 'VERCEL_ENV' };
  }

  // 3. Último recurso: `NODE_ENV` (fuera de Vercel).
  const nodeEnv = readNormalized(source, 'NODE_ENV');
  if (nodeEnv === 'production') {
    return { name: 'production', isProduction: true, source: 'NODE_ENV' };
  }
  if (nodeEnv) {
    return { name: 'development', isProduction: false, source: 'NODE_ENV' };
  }

  // Sin ninguna señal: NO es Producción (local/CI), pero queda declarado el origen.
  return { name: 'development', isProduction: false, source: 'default' };
}

/** ¿Producción real? La única pregunta que los gates necesitan responder. */
export function isProductionRuntime(source: RuntimeEnvSource = process.env): boolean {
  return resolveRuntimeEnvironment(source).isProduction;
}

/** Complemento explícito, para que un gate se lea como una sola frase. */
export function isNonProductionRuntime(source: RuntimeEnvSource = process.env): boolean {
  return !isProductionRuntime(source);
}
