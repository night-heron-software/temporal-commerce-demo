/**
 * Identity Domain Activity Implementations
 *
 * These are the actual functions registered with the Temporal worker.
 * They perform side effects (DB calls) and are NOT imported by workflow code.
 */

import { createLogger } from '../../lib';
import type { Identity } from '../contracts';
import { UserRepository } from './db/user-repository';
import { ShopperRepository } from './db/shopper-repository';
import { ApiTokenRepository } from './db/api-token-repository';
import { AuditRepository } from './db/audit-repository';
import { FeatureFlagsRepository } from './db/feature-flags-repository';

const logger = createLogger('identity:activities');
const userRepo = new UserRepository();
const shopperRepo = new ShopperRepository();
const tokenRepo = new ApiTokenRepository();
const auditRepo = new AuditRepository();
const flagsRepo = new FeatureFlagsRepository();

// ─── Feature Flag Activities ────────────────────────────────────────

export async function getFeatureFlag(name: string): Promise<boolean> {
  const flag = await flagsRepo.getFeatureFlag(name);
  const enabled = flag?.enabled ?? false;
  logger.info({ flagName: name, enabled }, 'Activity: getFeatureFlag');
  return enabled;
}

export async function upsertFeatureFlag(params: { name: string; enabled: boolean; description: string | null }): Promise<void> {
  await flagsRepo.upsertFeatureFlag(params);
  logger.info({ flagName: params.name, enabled: params.enabled }, 'Activity: upsertFeatureFlag');
}

export async function deleteFeatureFlag(name: string): Promise<void> {
  await flagsRepo.deleteFeatureFlag(name);
  logger.info({ flagName: name }, 'Activity: deleteFeatureFlag');
}

// ─── User Activities ────────────────────────────────────────────────

export async function createUser(user: Identity.User): Promise<void> {
  await userRepo.createUser(user);
}

export async function updateUserName(email: string, name: string): Promise<void> {
  await userRepo.updateName(email, name);
}

export async function updateUserRole(email: string, role: 'admin' | 'developer' | 'user'): Promise<void> {
  await userRepo.updateRole(email, role);
}

export async function updateUserPassword(email: string, hash: string): Promise<void> {
  await userRepo.updatePassword(email, hash);
}

export async function deleteUser(email: string): Promise<void> {
  await userRepo.deleteUser(email);
}

// ─── Shopper Activities ─────────────────────────────────────────────

export async function createShopper(storeId: string, shopper: { id: string; email: string; passwordHash: string; name: string; phone?: string }): Promise<void> {
  await shopperRepo.createShopper(storeId, shopper);
}

export async function updateShopperProfile(storeId: string, email: string, updates: { name?: string; phone?: string }): Promise<void> {
  await shopperRepo.updateShopper(storeId, email, updates);
}

export async function updateShopperPassword(storeId: string, email: string, hash: string): Promise<void> {
  await shopperRepo.updatePassword(storeId, email, hash);
}

// ─── API Token Activities ───────────────────────────────────────────

export async function createApiToken(input: Identity.CreateTokenInput): Promise<{ rawToken: string; token: Omit<Identity.ApiToken, 'scopes'> & { scopes: string[] } }> {
  const result = await tokenRepo.createToken(input);
  return {
    rawToken: result.rawToken,
    token: {
      ...result.token,
      scopes: Array.from(result.token.scopes),
    }
  };
}

export async function revokeApiToken(tokenId: string): Promise<boolean> {
  return await tokenRepo.revokeToken(tokenId);
}

export async function deleteApiToken(tokenId: string): Promise<boolean> {
  return await tokenRepo.deleteToken(tokenId);
}

// ─── Audit Activities ───────────────────────────────────────────────

export async function logAudit(storeId: string, entry: Identity.AuditEntry): Promise<void> {
  await auditRepo.log(storeId, entry);
}
