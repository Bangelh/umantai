/**
 * tests/geo-geoapify.test.ts — contrato del adaptador Geoapify.
 *
 * No se llama a la red: se simula `fetch` y se verifica lo que realmente
 * importa del adaptador:
 *   · la key viaja como parámetro y el servidor es el único que la usa;
 *   · toda búsqueda se acota a Perú y se sesga al distrito elegido;
 *   · la confianza solo es alta cuando el proveedor devuelve el MISMO distrito;
 *   · sin key el adaptador queda no disponible (nunca inventa coordenadas).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createGeoapifyGeocoder } from '../lib/geo/providers/geoapify';
import type { UbigeoChain } from '../lib/geo/types';

const CHAIN: UbigeoChain = {
  code: '200706',
  department: 'Piura',
  province: 'Talara',
  district: 'Máncora',
  centroid: { latitude: -4.1069, longitude: -81.0539 },
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

test('forward acota a Perú, sesga al distrito y marca confianza alta si coincide', async () => {
  process.env.GEOAPIFY_API_KEY = 'test-key';
  const captured: Captured[] = [];
  stubFetch(
    feature(
      {
        formatted: 'Av. Grau 123, Máncora 20851, Perú',
        district: 'Máncora',
        county: 'Talara',
        state: 'Piura',
        lat: -4.1071,
        lon: -81.0541,
        rank: { confidence: 0.92 },
      },
      [-81.0541, -4.1071],
    ),
    captured,
  );

  const geocoder = createGeoapifyGeocoder();
  const hit = await geocoder.forward({ address: 'Av. Grau 123', ubigeo: CHAIN });

  assert.ok(hit);
  assert.equal(hit.point.latitude, -4.1071);
  assert.equal(hit.point.longitude, -81.0541);
  assert.equal(hit.confidence, 'high');
  assert.equal(hit.district, 'Máncora');
  assert.equal(hit.province, 'Talara');
  assert.equal(hit.department, 'Piura');

  const url = new URL(captured[0].url);
  assert.equal(url.pathname, '/v1/geocode/search');
  assert.match(url.searchParams.get('text') ?? '', /Av\. Grau 123, Máncora, Talara, Piura, Perú/);
  assert.equal(url.searchParams.get('filter'), 'countrycode:pe');
  assert.equal(url.searchParams.get('lang'), 'es');
  assert.equal(url.searchParams.get('apiKey'), 'test-key');
  assert.equal(url.searchParams.get('bias'), 'proximity:-81.0539,-4.1069');
});

test('un resultado de otro distrito se marca como confianza baja', async () => {
  process.env.GEOAPIFY_API_KEY = 'test-key';
  stubFetch(
    feature(
      { formatted: 'Av. Grau 123, Piura, Perú', district: 'Piura', county: 'Piura', state: 'Piura' },
      [-80.63, -5.19],
    ),
    [],
  );

  const hit = await createGeoapifyGeocoder().forward({ address: 'Av. Grau 123', ubigeo: CHAIN });
  assert.equal(hit?.confidence, 'low');
});

test('sin resultados devuelve null (nunca el centroide como si fuera la dirección)', async () => {
  process.env.GEOAPIFY_API_KEY = 'test-key';
  stubFetch({ features: [] }, []);
  assert.equal(await createGeoapifyGeocoder().forward({ address: 'Calle Inventada 9999', ubigeo: CHAIN }), null);
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
        district: 'Máncora',
        county: 'Talara',
        state: 'Piura',
        lat: -4.1071,
        lon: -81.0541,
      },
      [-81.0541, -4.1071],
    ),
    captured,
  );

  const hit = await createGeoapifyGeocoder().reverse({ latitude: -4.1071, longitude: -81.0541 });
  assert.ok(hit);
  assert.equal(hit.addressLine, 'Av. Grau 123, Máncora 20851, Perú');
  assert.equal(hit.district, 'Máncora');
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
