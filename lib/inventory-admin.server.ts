/**
 * lib/inventory-admin.server.ts — operaciones de inventario del admin.
 *
 * Toda cantidad entra por `inventory_apply_movement()`: transacción + row lock +
 * validación `on_hand >= 0` y `on_hand - reserved >= 0` dentro de Postgres. Acá
 * NO se hace `SELECT` + `UPDATE` desde JavaScript.
 */

import { toAdminInventoryItem, type AdminInventoryItem, type AdjustmentInput, type ReceiptInput, type ThresholdInput } from './inventory-admin';
import { resolveCatalogVariant } from './inventory-catalog';
import {
  applyInventoryMovement,
  getInventoryItem,
  setReorderPoint,
} from './commerce.server';
import type { InventoryMovement } from './commerce';

export type InventoryAdminErrorCode =
  | 'unknown_product'
  | 'invalid_variant'
  | 'insufficient_stock'
  | 'inventory_write_failed';

export class InventoryAdminError extends Error {
  readonly code: InventoryAdminErrorCode;
  readonly status: number;

  constructor(message: string, code: InventoryAdminErrorCode, status = 400) {
    super(message);
    this.name = 'InventoryAdminError';
    this.code = code;
    this.status = status;
  }
}

export interface ReceiptExecution {
  item: AdminInventoryItem;
  movement: InventoryMovement;
  /** El ingreso se aplicó, pero el umbral no se pudo guardar. */
  thresholdWarning: string | null;
}

export async function executeReceipt(input: ReceiptInput): Promise<ReceiptExecution> {
  const resolution = resolveCatalogVariant(input.productSlug, input.variantKey);
  if (!resolution.ok) {
    const code = resolution.error.startsWith('Producto') ? 'unknown_product' : 'invalid_variant';
    throw new InventoryAdminError(resolution.error, code);
  }

  const movement = await applyInventoryMovement({
    productSlug: input.productSlug,
    variantKey: input.variantKey,
    movementType: 'receipt',
    onHandDelta: input.quantity,
    reason: input.reason ?? 'merchandise receipt',
    performedBy: input.actor,
    idempotencyKey: input.idempotencyKey,
  });

  let thresholdWarning: string | null = null;
  if (input.reorderPoint !== null) {
    try {
      await setReorderPoint(input.productSlug, input.variantKey, input.reorderPoint);
    } catch (error) {
      console.error('[inventory] el ingreso se aplicó pero falló el umbral', error);
      thresholdWarning = 'El ingreso se registró, pero no se pudo guardar el umbral de stock bajo.';
    }
  }

  const item = await getInventoryItem(input.productSlug, input.variantKey);
  if (!item) {
    throw new InventoryAdminError('No se pudo leer el inventario actualizado.', 'inventory_write_failed', 500);
  }

  return {
    item: toAdminInventoryItem(item, resolution.product),
    movement,
    thresholdWarning,
  };
}

export interface AdjustmentExecution {
  item: AdminInventoryItem;
  movement: InventoryMovement;
  before: { onHand: number; reserved: number; available: number };
}

export async function executeAdjustment(input: AdjustmentInput): Promise<AdjustmentExecution> {
  const resolution = resolveCatalogVariant(input.productSlug, input.variantKey);
  if (!resolution.ok) {
    const code = resolution.error.startsWith('Producto') ? 'unknown_product' : 'invalid_variant';
    throw new InventoryAdminError(resolution.error, code);
  }

  let movement: InventoryMovement;
  try {
    movement = await applyInventoryMovement({
      productSlug: input.productSlug,
      variantKey: input.variantKey,
      movementType: 'adjustment',
      onHandDelta: input.delta,
      reason: input.reason,
      performedBy: input.actor,
      idempotencyKey: input.idempotencyKey,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('insufficient_stock')) {
      throw new InventoryAdminError(
        'El ajuste dejaría el stock físico por debajo de lo reservado.',
        'insufficient_stock',
        409,
      );
    }
    throw error;
  }

  const item = await getInventoryItem(input.productSlug, input.variantKey);
  if (!item) {
    throw new InventoryAdminError('No se pudo leer el inventario actualizado.', 'inventory_write_failed', 500);
  }

  const onHand = movement.onHandAfter - movement.onHandDelta;
  const reserved = movement.reservedAfter - movement.reservedDelta;

  return {
    item: toAdminInventoryItem(item, resolution.product),
    movement,
    before: {
      onHand,
      reserved,
      available: onHand - reserved,
    },
  };
}

export async function executeThreshold(input: ThresholdInput): Promise<AdminInventoryItem> {
  const resolution = resolveCatalogVariant(input.productSlug, input.variantKey);
  if (!resolution.ok) {
    const code = resolution.error.startsWith('Producto') ? 'unknown_product' : 'invalid_variant';
    throw new InventoryAdminError(resolution.error, code);
  }

  const item = await setReorderPoint(input.productSlug, input.variantKey, input.reorderPoint);
  if (!item) {
    throw new InventoryAdminError('No se pudo guardar el umbral.', 'inventory_write_failed', 500);
  }

  return toAdminInventoryItem(item, resolution.product);
}
