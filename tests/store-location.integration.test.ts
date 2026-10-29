/**
 * tests/store-location.integration.test.ts — PostgreSQL real (efímero).
 *
 * Cubre el contrato de la migración 025/026:
 *   · el catálogo INEI se carga completo;
 *   · ubigeo es canónico y el trigger deriva department/province/district/city;
 *   · un ubigeo inexistente lo rechaza la FK;
 *   · un pin fuera del Perú lo rechaza el CHECK;
 *   · las tiendas legacy (sin ubigeo) siguen funcionando.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { closeDbPools } from '../lib/db-driver.server';
import type * as UbigeoModule from '../lib/geo/ubigeo.server';
import type * as Platform from '../lib/platform-db.server';
import { startTestDatabase, type EmbeddedTestDatabase } from './helpers/embedded-postgres';

let database: EmbeddedTestDatabase;
let platform: typeof Platform;
let ubigeo: typeof UbigeoModule;

const slug = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

before(async () => {
  database = await startTestDatabase();
  process.env.DB_DRIVER = 'pg';
  process.env.POSTGRES_URL_NON_POOLING = database.url;
  process.env.APP_ENV = 'test';
  delete process.env.VERCEL_ENV;

  platform = await import('../lib/platform-db.server');
  ubigeo = await import('../lib/geo/ubigeo.server');
});

after(async () => {
  await closeDbPools();
  await database.stop();
});

test('el catálogo UBIGEO está cargado completo', async () => {
  const sql = platform.requirePlatformSql();
  const [row] = (await sql`
    SELECT
      (SELECT count(*)::int FROM ubigeo_departments) AS departments,
      (SELECT count(*)::int FROM ubigeo_provinces) AS provinces,
      (SELECT count(*)::int FROM ubigeo_districts) AS districts
  `) as { departments: number; provinces: number; districts: number }[];

  assert.equal(row.departments, 25);
  assert.ok(row.provinces >= 190);
  assert.ok(row.districts >= 1800);
});

test('los selects dependientes devuelven la jerarquía real', async () => {
  const provinces = await ubigeo.listProvinces('20');
  assert.ok(provinces.some((item) => item.code === '2007' && item.name === 'Talara'));

  const districts = await ubigeo.listDistricts('2007');
  const mancora = districts.find((item) => item.code === '200706');
  assert.ok(mancora, 'falta Máncora en Talara');
  assert.equal(mancora?.name, 'Máncora');
  assert.ok((mancora?.latitude ?? 0) < -4);
  assert.ok((mancora?.longitude ?? 0) < -81);

  const chain = await ubigeo.getUbigeoChain('200706');
  assert.equal(chain?.department, 'Piura');
  assert.equal(chain?.province, 'Talara');
  assert.equal(chain?.district, 'Máncora');
  assert.ok(chain?.centroid);
});

test('el trigger deriva los nombres y descarta lo que mande el cliente', async () => {
  const sql = platform.requirePlatformSql();
  const rows = await sql`
    INSERT INTO stores (
      name, slug, address, ubigeo, reference, location_source,
      district, city, latitude, longitude, active
    ) VALUES (
      'Tienda Máncora', ${slug('mancora')}, 'Av. Grau 123', '200706', 'Frente al mercado',
      'map_pin', 'Distrito Inventado', 'Ciudad Inventada', -4.1069, -81.0539, FALSE
    )
    RETURNING district, province, department, city, ubigeo
  `;

  assert.deepEqual(rows[0], {
    district: 'Máncora',
    province: 'Talara',
    department: 'Piura',
    city: 'Talara',
    ubigeo: '200706',
  });
});

test('cambiar el ubigeo re-sincroniza departamento, provincia y distrito', async () => {
  const sql = platform.requirePlatformSql();
  const [store] = (await sql`
    INSERT INTO stores (
      name, slug, address, ubigeo, latitude, longitude, active, location_source
    ) VALUES (
      'Tienda que se muda', ${slug('mudanza')}, 'Calle 1', '150122', -12.1219, -77.0297, FALSE, 'map_pin'
    )
    RETURNING id, district, province, department
  `) as { id: string; district: string; province: string; department: string }[];

  assert.equal(store.district, 'Miraflores');
  assert.equal(store.province, 'Lima');
  assert.equal(store.department, 'Lima');

  const [updated] = (await sql`
    UPDATE stores SET ubigeo = '200706'
     WHERE id = ${store.id}::uuid
    RETURNING district, province, department, city
  `) as { district: string; province: string; department: string; city: string }[];

  assert.equal(updated.district, 'Máncora');
  assert.equal(updated.province, 'Talara');
  assert.equal(updated.department, 'Piura');
  assert.equal(updated.city, 'Talara');
});

test('un ubigeo inexistente lo rechaza la base', async () => {
  const sql = platform.requirePlatformSql();
  await assert.rejects(
    async () => {
      await sql`
        INSERT INTO stores (name, slug, ubigeo, active)
        VALUES ('Fantasma', ${slug('fantasma')}, '999999', FALSE)
      `;
    },
    (error: { code?: string }) => error.code === '23503',
  );
});

test('un pin fuera del Perú lo rechaza el CHECK', async () => {
  const sql = platform.requirePlatformSql();
  await assert.rejects(
    async () => {
      await sql`
        INSERT INTO stores (name, slug, ubigeo, latitude, longitude, active)
        VALUES ('Bogotá', ${slug('bogota')}, '110101', 4.6, -74.08, FALSE)
      `;
    },
    (error: { code?: string }) => error.code === '23514',
  );
});

test('una tienda legacy sin ubigeo conserva su distrito de texto', async () => {
  const sql = platform.requirePlatformSql();
  const legacySlug = slug('legacy');
  const [store] = (await sql`
    INSERT INTO stores (name, slug, district, city, latitude, longitude, active, location_source)
    VALUES ('Legacy', ${legacySlug}, 'Zona antigua', 'Lima', -12.0464, -77.0428, FALSE, 'legacy_zone')
    RETURNING ubigeo, district, province, department, city
  `) as { ubigeo: string | null; district: string; province: string | null; department: string | null; city: string }[];

  assert.equal(store.ubigeo, null);
  assert.equal(store.district, 'Zona antigua');
  assert.equal(store.city, 'Lima');
  assert.equal(store.province, null);
  assert.equal(store.department, null);

  // Y sigue pudiendo activarse: el constraint solo exige lat/lng.
  const [activated] = (await sql`
    UPDATE stores SET active = TRUE WHERE slug = ${legacySlug} RETURNING active
  `) as { active: boolean }[];
  assert.equal(activated.active, true);
});

test('una tienda no puede activarse sin pin', async () => {
  const sql = platform.requirePlatformSql();
  await assert.rejects(
    async () => {
      await sql`
        INSERT INTO stores (name, slug, active)
        VALUES ('Sin pin', ${slug('sin-pin')}, TRUE)
      `;
    },
    (error: { code?: string }) => error.code === '23514',
  );
});

test('matchUbigeoByName solo resuelve coincidencias inequívocas', async () => {
  const hit = await ubigeo.matchUbigeoByName({
    department: 'Piura',
    province: 'Talara',
    district: 'Máncora',
  });
  assert.equal(hit?.code, '200706');

  const wrongProvince = await ubigeo.matchUbigeoByName({
    department: 'Piura',
    province: 'Paita',
    district: 'Máncora',
  });
  assert.equal(wrongProvince, null);

  const unknown = await ubigeo.matchUbigeoByName({
    department: 'Lima',
    province: 'Lima',
    district: 'Distrito Inexistente',
  });
  assert.equal(unknown, null);
});

test('el barrio del proveedor no impide resolver el distrito (Máncora)', async () => {
  for (const neighborhood of ['Barrio Nicaragua', 'Barrio Santa Rosa']) {
    const chain = await ubigeo.resolveUbigeoFromCandidates({
      department: 'Piura',
      province: 'Talara',
      names: [neighborhood, 'Máncora'],
    });
    assert.equal(chain?.code, '200706', neighborhood);
    assert.equal(chain?.district, 'Máncora');
    assert.equal(chain?.province, 'Talara');
    assert.equal(chain?.department, 'Piura');
  }
});

test('en Lima resuelve el distrito, no la ciudad (district ≠ city)', async () => {
  const chain = await ubigeo.resolveUbigeoFromCandidates({
    department: 'Lima',
    province: 'Lima',
    names: ['Miraflores', 'Lima'],
  });
  assert.equal(chain?.code, '150122');
  assert.equal(chain?.district, 'Miraflores');
});

test('un punto de borde/playa resuelve el distrito por su ciudad', async () => {
  const chain = await ubigeo.resolveUbigeoFromCandidates({
    department: 'Piura',
    province: 'Talara',
    names: ['Barrio Santa Rosa', null, 'Máncora'],
  });
  assert.equal(chain?.code, '200706');
});

test('sin coincidencia inequívoca no se inventa ubigeo', async () => {
  const ambiguous = await ubigeo.resolveUbigeoFromCandidates({
    department: null,
    province: null,
    names: ['San Juan'],
  });
  assert.equal(ambiguous, null);

  const unknown = await ubigeo.resolveUbigeoFromCandidates({
    department: 'Piura',
    province: 'Talara',
    names: ['Barrio Inexistente'],
  });
  assert.equal(unknown, null);

  const wrongProvince = await ubigeo.resolveUbigeoFromCandidates({
    department: 'Piura',
    province: 'Paita',
    names: ['Máncora'],
  });
  assert.equal(wrongProvince, null);
});
