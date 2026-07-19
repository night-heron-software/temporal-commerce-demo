/**
 * Identity Domain Activity Implementations
 *
 * These are the actual functions registered with the Temporal worker.
 * They perform side effects (DB calls) and are NOT imported by workflow code.
 */

import { ShopperRepository } from './db/shopper-repository';
import { AddressRepository } from './db/address-repository';
import type { Identity } from '../contracts';

const shopperRepo = new ShopperRepository();
const addressRepo = new AddressRepository();

// ─── Shopper Activities ─────────────────────────────────────────────

export async function createShopper(shopper: {
  id: string;
  email: string;
  passwordHash: string;
  name: string;
  phone?: string;
}): Promise<void> {
  await shopperRepo.createShopper(shopper);
}

export async function updateShopperProfile(
  email: string,
  updates: { name?: string; phone?: string },
): Promise<void> {
  await shopperRepo.updateShopper(email, updates);
}

export async function updateShopperPassword(email: string, hash: string): Promise<void> {
  await shopperRepo.updatePassword(email, hash);
}

/**
 * Save (upsert) a shopper's shipping address. One logical write (INSERT plus the
 * default-flag maintenance inside the repository) — eligible as a standalone
 * activity per ADR-0006.
 */
export async function saveShopperAddress(
  userId: string,
  address: Identity.SavedAddress,
): Promise<void> {
  await addressRepo.save(userId, address);
}
