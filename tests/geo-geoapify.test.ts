/**
 * tests/geo-geoapify.test.ts — contrato del adaptador Geoapify.
 *
 * No se llama a la red: se simula `fetch` y se verifica lo que realmente
 * importa del adaptador:
 *   · la key viaja como parámetro y el servidor es el único que la usa;
 *   · toda búsqueda se acota a Perú y se sesga al distrito elegido;
 *   · una coincidencia SOLO administrativa (centro del distrito) no es dirección;
 *   · `high` exige una vía identificada, rank suficiente y el mismo distrito;
 *   · el mapeo territorial peruano (barrio ≠ distrito) viaja en candidatos;
 *   · sin key el adaptador queda no disponible (nunca inventa coordenadas).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createGeoapifyGeocoder, precisionOf } from '../lib/geo/providers/geoapify';
import type { UbigeoChain } from '../lib/geo/types';

const CHAIN: UbigeoChain = {
  code: '200706',
  department: 'Piura',
  province: 'Talara',
  district: 'Máncora',
  centroid: { latitude: -4.1069, longitude: -81.0539 },
};

const MIRAFLORES: UbigeoChain = {
  code: '150122',
  department: 'Lima',
  province: 'Lima',
  district: 'Miraflores',
  centroid: { latitude: -12.1219, longitude: -77.0297 },
};

interface Captured {
  url: string;
}

function stubFetch(payload: unknown, captured: Captured[], status = 200) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    captured.push({ url: String(input) });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

function feature(properties: Record<string, unknown>, coordinates: [number, number]) {
  return {
    features: [
      {
        type: 'Feature',
        properties,
        geometry: { type: 'Point', coordinates },
      },
    ],
  };
}

test('sin key el adaptador no está disponible y no inventa puntos', async () => {
  delete process.env.GEOAPIFY_API_KEY;
  const geocoder = createGeoapifyGeocoder();
  assert.equal(geocoder.available, false);
  assert.equal(geocoder.name, 'geoapify');
  assert.equal(await geocoder.forward({ address: 'Av. Grau 123', ubigeo: CHAIN }), null);
  assert.equal(await geocoder.reverse({ latitude: -4.1, longitude: -81.05 }), null);
});

test('clasifica match_type en precisión (administrativo nunca es dirección)', () => {
  assert.equal(precisionOf('full_match'), 'exact');
  assert.equal(precisionOf('match_by_building'), 'exact');
  assert.equal(precisionOf('match_by_street'), 'approximate');
  assert.equal(precisionOf('match_by_city_or_disrict'), 'administrative');
  assert.equal(precisionOf('match_by_postcode'), 'administrative');
  assert.equal(precisionOf(undefined), 'unknown');
});

test('dirección exacta: acota a Perú, sesga al distrito y marca confianza alta', async () => {
  process.env.GEOAPIFY_API_KEY = 'test-key';
  const captured: Captured[] = [];
  stubFetch(
    feature(
      {
        formatted: 'Calle Los Pinos, Máncora 20851, Perú',
        address_line1: 'Calle Los Pinos',
        district: 'Barrio Santa Rosa',
        city: 'Máncora',
        county: 'Talara',
        state: 'Piura',
        lat: -4.1061,
        lon: -81.0535,
        rank: { confidence: 0.92, match_type: 'full_match' },
      },
      [-81.0535, -4.1061],
    ),
    captured,
  );

  const hit = await createGeoapifyGeocoder().forward({ address: 'Calle Los Pinos', ubigeo: CHAIN });

  assert.ok(hit);
  assert.equal(hit.point.latitude, -4.1061);
  assert.equal(hit.point.longitude, -81.0535);
  assert.equal(hit.confidence, 'high');
  assert.equal(hit.precision, 'exact');
  // El barrio NO se confunde con el distrito: ambos viajan como candidatos.
  assert.deepEqual(hit.districtCandidates, ['Barrio Santa Rosa', 'Máncora']);
  assert.equal(hit.province, 'Talara');
  assert.equal(hit.department, 'Piura');

  const url = new URL(captured[0].url);
  assert.equal(url.pathname, '/v1/geocode/search');
  assert.match(url.searchParams.get('text') ?? '', /Calle Los Pinos, Máncora, Talara, Piura, Perú/);
  assert.equal(url.searchParams.get('filter'), 'countrycode:pe');
  assert.equal(url.searchParams.get('lang'), 'es');
  assert.equal(url.searchParams.get('apiKey'), 'test-key');
  assert.equal(url.searchParams.get('bias'), 'proximity:-81.0539,-4.1069');
});

test('dirección aproximada: hay calle pero el rank es bajo → low, nunca high', async () => {
  process.env.GEOAPIFY_API_KEY = 'test-key';
  stubFetch(
    feature(
      {
        formatted: 'Calle Miguel Grau 123, Máncora 20851, Perú',
        address_line1: 'Calle Miguel Grau 123',
        district: 'Barrio Nicaragua',
        city: 'Máncora',
        county: 'Talara',
        state: 'Piura',
        rank: { confidence: 0.45, match_type: 'full_match' },
      },
      [-81.0436, -4.1057],
    ),
    [],
  );

  const hit = await createGeoapifyGeocoder().forward({ address: 'Av. Grau 123', ubigeo: CHAIN });
  assert.ok(hit);
  assert.equal(hit.confidence, 'low');
  assert.equal(hit.precision, 'exact');
});

test('calle sin número (match_by_street) → low, no se presenta como exacta', async () => {
  process.env.GEOAPIFY_API_KEY = 'test-key';
  stubFetch(
    feature(
      {
        formatted: 'Calle Los Pinos, Máncora 20851, Perú',
        address_line1: 'Calle Los Pinos',
        city: 'Máncora',
        county: 'Talara',
        state: 'Piura',
        rank: { confidence: 0.8, match_type: 'match_by_street' },
      },
      [-81.0535, -4.1061],
    ),
    [],
  );

  const hit = await createGeoapifyGeocoder().forward({ address: 'Calle Los Pinos', ubigeo: CHAIN });
  assert.ok(hit);
  assert.equal(hit.confidence, 'low');
  assert.equal(hit.precision, 'approximate');
});

test('solo distrito (match_by_city_or_disrict) → null: el centro no es una dirección', async () => {
  process.env.GEOAPIFY_API_KEY = 'test-key';
  stubFetch(
    feature(
      {
        formatted: 'Máncora 20851, Perú',
        address_line1: 'Máncora',
        city: 'Máncora',
        state: 'Piura',
        lat: -4.10778,
        lon: -81.0475,
        rank: { confidence: 0.5, match_type: 'match_by_city_or_disrict' },
      },
      [-81.0475, -4.10778],
    ),
    [],
  );

  assert.equal(
    await createGeoapifyGeocoder().forward({ address: 'Calle Ficticia 123', ubigeo: CHAIN }),
    null,
  );
});

test('texto basura → null aunque el proveedor devuelva el centro del distrito', async () => {
  process.env.GEOAPIFY_API_KEY = 'test-key';
  stubFetch(
    feature(
      {
        formatted: 'Máncora, PI, Perú',
        city: 'Máncora',
        state: 'Piura',
        lat: -4.10778,
        lon: -81.0475,
        rank: { confidence: 0.5, match_type: 'match_by_city_or_disrict' },
      },
      [-81.0475, -4.10778],
    ),
    [],
  );

  for (const address of ['zzzz qqq 0000', 'Asdfghjkl 987', 'Calle Ficticia Que No Existe 99999']) {
    assert.equal(await createGeoapifyGeocoder().forward({ address, ubigeo: CHAIN }), null, address);
  }
});

test('calle inexistente con match exacto pero address_line1 = ciudad → null', async () => {
  process.env.GEOAPIFY_API_KEY = 'test-key';
  stubFetch(
    feature(
      {
        formatted: 'Máncora 20851, Perú',
        address_line1: 'Máncora',
        city: 'Máncora',
        county: 'Talara',
        state: 'Piura',
        rank: { confidence: 0.9, match_type: 'full_match' },
      },
      [-81.0475, -4.10778],
    ),
    [],
  );

  assert.equal(
    await createGeoapifyGeocoder().forward({ address: 'Calle Que No Existe 12', ubigeo: CHAIN }),
    null,
  );
});

test('respuesta vacía → null (nunca el centroide como si fuera la dirección)', async () => {
  process.env.GEOAPIFY_API_KEY = 'test-key';
  stubFetch({ features: [] }, []);
  assert.equal(
    await createGeoapifyGeocoder().forward({ address: 'Calle Inventada 9999', ubigeo: CHAIN }),
    null,
  );
});

test('un resultado de otro distrito se marca como confianza baja', async () => {
  process.env.GEOAPIFY_API_KEY = 'test-key';
  stubFetch(
    feature(
      {
        formatted: 'Av. Grau 123, Piura, Perú',
        address_line1: 'Av. Grau 123',
        city: 'Piura',
        county: 'Piura',
        state: 'Piura',
        rank: { confidence: 0.95, match_type: 'full_match' },
      },
      [-80.63, -5.19],
    ),
    [],
  );

  const hit = await createGeoapifyGeocoder().forward({ address: 'Av. Grau 123', ubigeo: CHAIN });
  assert.ok(hit);
  assert.equal(hit.confidence, 'low');
});

test('Lima: district = Miraflores y city = Lima viajan como candidatos', async () => {
  process.env.GEOAPIFY_API_KEY = 'test-key';
  stubFetch(
    feature(
      {
        formatted: 'Av. Larco 456, Miraflores 15074, Perú',
        address_line1: 'Av. Larco 456',
        district: 'Miraflores',
        city: 'Lima',
        county: 'Lima',
        state: 'Lima',
        rank: { confidence: 0.93, match_type: 'full_match' },
      },
      [-77.0297, -12.1219],
    ),
    [],
  );

  const hit = await createGeoapifyGeocoder().forward({ address: 'Av. Larco 456', ubigeo: MIRAFLORES });
  assert.ok(hit);
  assert.equal(hit.confidence, 'high');
  assert.deepEqual(hit.districtCandidates, ['Miraflores', 'Lima']);
  assert.equal(hit.province, 'Lima');
  assert.equal(hit.department, 'Lima');
});

test('reverse separa dirección de línea administrativa y no sugiere ubigeo', async () => {
  process.env.GEOAPIFY_API_KEY = 'test-key';
  const captured: Captured[] = [];
  stubFetch(
    feature(
      {
        formatted: 'Av. Grau 123, Máncora 20851, Perú',
        address_line1: 'Av. Grau 123',
        address_line2: 'Máncora 20851, Perú',
        city: 'Máncora',
        county: 'Talara',
        state: 'Piura',
        lat: -4.1071,
        lon: -81.0541,
        rank: { confidence: 0.9, match_type: 'full_match' },
      },
      [-81.0541, -4.1071],
    ),
    captured,
  );

  const hit = await createGeoapifyGeocoder().reverse({ latitude: -4.1071, longitude: -81.0541 });
  assert.ok(hit);
  assert.equal(hit.addressLine, 'Av. Grau 123, Máncora 20851, Perú');
  assert.equal(hit.district, 'Máncora');
  assert.deepEqual(hit.districtCandidates, ['Máncora']);
  assert.equal(hit.confidence, 'high');
  // El ubigeo lo resuelve el servidor contra el catálogo, no el proveedor.
  assert.equal(hit.ubigeoHint, null);

  const url = new URL(captured[0].url);
  assert.equal(url.pathname, '/v1/geocode/reverse');
  assert.equal(url.searchParams.get('lat'), '-4.1071');
  assert.equal(url.searchParams.get('lon'), '-81.0541');
});

test('un error del proveedor se propaga para que la capa superior decida', async () => {
  process.env.GEOAPIFY_API_KEY = 'test-key';
  stubFetch({ message: 'rate limited' }, [], 429);
  await assert.rejects(
    () => createGeoapifyGeocoder().forward({ address: 'Av. Grau 123', ubigeo: CHAIN }),
    /geoapify_http_429/,
  );
});
