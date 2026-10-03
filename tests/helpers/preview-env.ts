/**
 * tests/helpers/preview-env.ts — efecto de importación para los tests de rutas.
 *
 * `lib/env.ts` calcula `envConfig` UNA sola vez, al importarse. Varias rutas exigen
 * "base de datos configurada" antes de atender la petición, así que la variable debe
 * existir ANTES de que ese módulo se evalúe.
 *
 * Se importa como PRIMERA línea del test (antes que la ruta bajo prueba). Es una URL
 * ficticia: en estos tests nunca se abre una conexión real (los candados de
 * diagnóstico responden antes de tocar Postgres, y la creación de la Preference usa
 * un `fetch` mockeado).
 */
process.env.POSTGRES_URL_NON_POOLING ??= 'postgres://test:test@localhost:5432/test';
