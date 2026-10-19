import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EMPTY_INVENTORY_FILTERS,
  filterInventoryItems,
  inventoryStatusFor,
  parseAdjustmentInput,
  parseInventoryListQuery,
  parseLedgerQuery,
  parseReceiptInput,
  parseThresholdInput,
  summarizeInventory,
  toAdminInventoryItem,
  type AdminInventoryItem,
} from '../lib/inventory-admin';
import type { InventoryItem } from '../lib/commerce';

function item(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: '00000000-0000-0000-0000-000000000000',
    locationCode: 'MAIN',
    productSlug: 'oura-ring-gen3',
    variantKey: 'color:stealth',
    quantityOnHand: 10,
    quantityReserved: 2,
    quantityAvailable: 8,
    reorderPoint: 0,
    restockEta: null,
    isActive: true,
    updatedAt: '2026-10-19T00:00:00.000Z',
    ...overrides,
  };
}

function adminItem(overrides: Partial<InventoryItem> = {}): AdminInventoryItem {
  return toAdminInventoryItem(item(overrides), { name: 'Oura Ring Gen3', brand: 'Oura' });
}

// =============================================================================
//  ESTADOS VISUALES
// =============================================================================

test('sin stock → agotado; en el umbral → poco stock; encima → disponible', () => {
  assert.equal(inventoryStatusFor(0, 5), 'out');
  assert.equal(inventoryStatusFor(5, 5), 'low');
  assert.equal(inventoryStatusFor(6, 5), 'available');
  assert.equal(inventoryStatusFor(1, 0), 'available', 'umbral 0 significa sin alerta');
});

test('el item de admin incluye nombre, marca y estado', () => {
  const enriched = adminItem({ quantityOnHand: 3, quantityReserved: 1, quantityAvailable: 2, reorderPoint: 2 });
  assert.equal(enriched.productName, 'Oura Ring Gen3');
  assert.equal(enriched.productBrand, 'Oura');
  assert.equal(enriched.status, 'low');
});

// =============================================================================
//  FILTROS Y RESUMEN
// =============================================================================

test('filtra por búsqueda, variante y estado', () => {
  const items = [
    adminItem(),
    adminItem({ productSlug: 'dyson-v15-detect', variantKey: '', quantityAvailable: 0 }),
    toAdminInventoryItem(
      item({ productSlug: 'paltas-hass-premium', variantKey: '', quantityOnHand: 2, quantityReserved: 0, quantityAvailable: 2, reorderPoint: 5 }),
      { name: 'Paltas Hass Premium', brand: 'Umantai Orchards' },
    ),
  ];

  assert.equal(filterInventoryItems(items, EMPTY_INVENTORY_FILTERS).length, 3);
  assert.equal(filterInventoryItems(items, { ...EMPTY_INVENTORY_FILTERS, q: 'paltas' }).length, 1);
  assert.equal(filterInventoryItems(items, { ...EMPTY_INVENTORY_FILTERS, status: 'out' }).length, 1);
  assert.equal(filterInventoryItems(items, { ...EMPTY_INVENTORY_FILTERS, variant: 'stealth' }).length, 1);
  assert.equal(filterInventoryItems(items, { ...EMPTY_INVENTORY_FILTERS, q: 'paltas', status: 'out' }).length, 0);
});

test('resumen suma unidades y cuenta alertas', () => {
  const summary = summarizeInventory([
    adminItem(),
    adminItem({ quantityOnHand: 3, quantityReserved: 1, quantityAvailable: 2, reorderPoint: 5 }),
    adminItem({ quantityOnHand: 1, quantityReserved: 1, quantityAvailable: 0 }),
  ]);

  assert.equal(summary.skuCount, 3);
  assert.equal(summary.unitsOnHand, 14);
  assert.equal(summary.unitsReserved, 4);
  assert.equal(summary.unitsAvailable, 10);
  assert.equal(summary.lowCount, 1);
  assert.equal(summary.outCount, 1);
});

// =============================================================================
//  VALIDACIÓN DE ENTRADAS
// =============================================================================

test('receipt válido normaliza actor, motivo y umbral', () => {
  const parsed = parseReceiptInput({
    productSlug: ' oura-ring-gen3 ',
    variantKey: ' color:stealth ',
    quantity: '4',
    reason: ' factura 001 ',
    actor: ' ana ',
    reorderPoint: '5',
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.productSlug, 'oura-ring-gen3');
  assert.equal(parsed.value.variantKey, 'color:stealth');
  assert.equal(parsed.value.quantity, 4);
  assert.equal(parsed.value.reason, 'factura 001');
  assert.equal(parsed.value.actor, 'ana');
  assert.equal(parsed.value.reorderPoint, 5);
});

test('receipt rechaza cantidad inválida, actor corto y umbral negativo', () => {
  assert.equal(parseReceiptInput({ productSlug: 'x', quantity: 0 }).ok, false);
  assert.equal(parseReceiptInput({ productSlug: 'x', quantity: 1.5 }).ok, false);
  assert.equal(parseReceiptInput({ productSlug: 'x', quantity: 1, actor: 'a' }).ok, false);
  assert.equal(parseReceiptInput({ productSlug: 'x', quantity: 1, reorderPoint: -1 }).ok, false);
});

test('ajuste exige delta distinto de cero y motivo obligatorio', () => {
  const ok = parseAdjustmentInput({
    productSlug: 'oura-ring-gen3',
    variantKey: 'color:stealth',
    delta: -3,
    reason: 'merma',
    actor: 'ana',
  });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.value.delta, -3);

  assert.equal(parseAdjustmentInput({ productSlug: 'x', delta: 0, reason: 'merma' }).ok, false);
  assert.equal(parseAdjustmentInput({ productSlug: 'x', delta: 2, reason: 'no' }).ok, false);
  assert.equal(parseAdjustmentInput({ productSlug: 'x', delta: 2, reason: 'ok!' }).ok, true);
});

test('umbral acepta 0 y rechaza negativos', () => {
  assert.equal(parseThresholdInput({ productSlug: 'x', reorderPoint: 0 }).ok, true);
  assert.equal(parseThresholdInput({ productSlug: 'x', reorderPoint: -1 }).ok, false);
  assert.equal(parseThresholdInput({ productSlug: '', reorderPoint: 3 }).ok, false);
});

// =============================================================================
//  QUERY STRINGS
// =============================================================================

test('query de inventario valida estado y límite', () => {
  const ok = parseInventoryListQuery(new URLSearchParams('q=oura&status=low&limit=20'));
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.value.filters.q, 'oura');
    assert.equal(ok.value.filters.status, 'low');
    assert.equal(ok.value.limit, 20);
  }

  assert.equal(parseInventoryListQuery(new URLSearchParams('status=roto')).ok, false);
  assert.equal(parseInventoryListQuery(new URLSearchParams('limit=9999')).ok, false);
});

test('ledger acepta filtros y normaliza fechas de día completo', () => {
  const parsed = parseLedgerQuery(
    new URLSearchParams('product=oura-ring-gen3&type=receipt&from=2026-10-01&to=2026-10-19&limit=25'),
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.productSlug, 'oura-ring-gen3');
  assert.equal(parsed.value.movementType, 'receipt');
  assert.equal(parsed.value.from, '2026-10-01T00:00:00.000Z');
  assert.equal(parsed.value.to, '2026-10-19T23:59:59.999Z');
  assert.equal(parsed.value.limit, 25);
});

test('ledger rechaza tipo desconocido, fechas invertidas y límite excesivo', () => {
  assert.equal(parseLedgerQuery(new URLSearchParams('type=magia')).ok, false);
  assert.equal(parseLedgerQuery(new URLSearchParams('from=2026-10-20&to=2026-10-01')).ok, false);
  assert.equal(parseLedgerQuery(new URLSearchParams('limit=9999')).ok, false);
});
