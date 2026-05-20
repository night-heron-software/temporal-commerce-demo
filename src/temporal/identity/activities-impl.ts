/**
 * Identity Domain Activity Implementations
 *
 * These are the actual functions registered with the Temporal worker.
 * They perform side effects (DB calls) and are NOT imported by workflow code.
 */

import { createLogger } from '../../lib';
import { ShopperRepository } from './db/shopper-repository';

const logger = createLogger('identity:activities');
const shopperRepo = new ShopperRepository();

// ─── Shopper Activities ─────────────────────────────────────────────

export async function createShopper(shopper: { id: string; email: string; passwordHash: string; name: string; phone?: string }): Promise<void> {
  await shopperRepo.createShopper(shopper);
}

export async function updateShopperProfile(email: string, updates: { name?: string; phone?: string }): Promise<void> {
  await shopperRepo.updateShopper(email, updates);
}

export async function updateShopperPassword(email: string, hash: string): Promise<void> {
  await shopperRepo.updatePassword(email, hash);
}
