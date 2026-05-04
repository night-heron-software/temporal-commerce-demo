/**
 * Identity Domain Activity Contracts
 *
 * This file is imported by workflow code (runs inside the Temporal sandbox).
 * It uses proxyActivities to create type-safe stubs.
 */

import { proxyActivities } from '@temporalio/workflow';
import type { Identity } from '../contracts';

// Feature Flag Activities
export const {
  getFeatureFlag,
  upsertFeatureFlag,
  deleteFeatureFlag
} = proxyActivities<Identity.GeneralActivities>({
  startToCloseTimeout: '10s',
  retry: {
    maximumAttempts: 3
  }
});

// Identity Activities (User, Shopper, Token, Audit)
export const {
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
} = proxyActivities<Identity.IdentityActivities>({
  startToCloseTimeout: '10s',
  retry: {
    maximumAttempts: 3
  }
});
