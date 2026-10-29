/**
 * lib/i18n/store-status.ts — etiqueta del estado de tienda, traducida.
 *
 * Mismo patrón que `orderStatusLabel`: el dominio (`lib/store-status.ts`) no
 * conoce textos y la UI no inventa su propia escala de estados.
 */

import type { MessageKey } from './dictionaries';
import type { Translator } from './index';
import type { MerchantStoreState } from '../store-status';

const LABELS: Record<'account' | 'merchant', Record<MerchantStoreState, MessageKey>> = {
  account: {
    active: 'account.active',
    pending_review: 'account.storePendingReview',
    incomplete: 'account.storeIncomplete',
  },
  merchant: {
    active: 'merchant.active',
    pending_review: 'merchant.pending',
    incomplete: 'merchant.incomplete',
  },
};

export function storeStatusLabel(
  t: Translator,
  state: MerchantStoreState,
  scope: 'account' | 'merchant' = 'merchant',
): string {
  return t(LABELS[scope][state]);
}
