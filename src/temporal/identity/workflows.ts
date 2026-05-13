/**
 * Identity Domain Workflows
 *
 * All workflows for user management, shopper management,
 * API token lifecycle, and feature flag administration.
 */

import {
  getFeatureFlag,
  upsertFeatureFlag,
  deleteFeatureFlag,
  createUser,
  updateUserName,
  updateUserRole,
  updateUserPassword,
  deleteUser,
  createShopper,
  updateShopperProfile,
  updateShopperPassword,
  createApiToken,
  revokeApiToken,
  deleteApiToken,
  logAudit
} from './activities';
import type { Identity } from '../contracts';

// ─── Feature Flag Workflows ────────────────────────────────────────

export async function upsertFeatureFlagWorkflow(params: {
  name: string;
  enabled: boolean;
  description: string | null;
}): Promise<void> {
  await upsertFeatureFlag(params);
}

export async function deleteFeatureFlagWorkflow(name: string): Promise<void> {
  await deleteFeatureFlag(name);
}

// ─── User Workflows ────────────────────────────────────────────────

export async function createUserWorkflow(user: Identity.User): Promise<void> {
  await createUser(user);
}

export async function updateUserNameWorkflow(email: string, name: string): Promise<void> {
  await updateUserName(email, name);
}

export async function updateUserRoleWorkflow(email: string, role: 'admin' | 'developer' | 'user'): Promise<void> {
  await updateUserRole(email, role);
}

export async function updateUserPasswordWorkflow(email: string, hash: string): Promise<void> {
  await updateUserPassword(email, hash);
}

export async function deleteUserWorkflow(email: string): Promise<void> {
  await deleteUser(email);
}

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

// ─── API Token Workflows ───────────────────────────────────────────

export async function createApiTokenWorkflow(
  input: Identity.CreateTokenInput,
  auditContext: { actorEmail: string; actorRole: string }
): Promise<{ rawToken: string; token: Omit<Identity.ApiToken, 'scopes'> & { scopes: string[] } }> {
  const result = await createApiToken(input);
  
  await logAudit({
    actorEmail: auditContext.actorEmail,
    actorRole: auditContext.actorRole,
    action: 'create_token',
    targetEmail: input.userEmail !== auditContext.actorEmail ? input.userEmail : undefined,
    targetResource: `token:${result.token.tokenId}`,
    metadata: { name: input.name, scopes: input.scopes, userType: input.userType }
  });

  return result;
}

export async function revokeApiTokenWorkflow(
  tokenId: string,
  tokenName: string,
  tokenUserType: string,
  auditContext: { lookupEmail: string; actorEmail: string; actorRole: string }
): Promise<boolean> {
  const success = await revokeApiToken(tokenId);
  
  if (success) {
    await logAudit({
      actorEmail: auditContext.actorEmail,
      actorRole: auditContext.actorRole,
      action: 'revoke_token',
      targetEmail: auditContext.lookupEmail !== auditContext.actorEmail ? auditContext.lookupEmail : undefined,
      targetResource: `token:${tokenId}`,
      metadata: { name: tokenName, userType: tokenUserType }
    });
  }
  
  return success;
}

export async function deleteApiTokenWorkflow(tokenId: string): Promise<boolean> {
  return await deleteApiToken(tokenId);
}
