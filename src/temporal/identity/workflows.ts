/**
 * Identity Domain Workflows
 *
 * All workflows for shopper management.
 */

import {
  createShopper,
  updateShopperProfile,
  updateShopperPassword
} from './activities';

// ─── Shopper Workflows ─────────────────────────────────────────────

export async function createShopperWorkflow(shopper: { id: string; email: string; passwordHash: string; name: string; phone?: string }): Promise<void> {
  await createShopper(shopper);
}

export async function updateShopperProfileWorkflow(email: string, updates: { name?: string; phone?: string }): Promise<void> {
  await updateShopperProfile(email, updates);
}

export async function updateShopperPasswordWorkflow(email: string, hash: string): Promise<void> {
  await updateShopperPassword(email, hash);
}
