/**
 * Identity Domain Activity Contracts
 *
 * This file is imported by workflow code (runs inside the Temporal sandbox).
 * It uses proxyActivities to create type-safe stubs.
 */

import { proxyActivities } from '@temporalio/workflow';
import type { Identity } from '../contracts';

// Identity Activities (Shopper only)
export const {
  createShopper,
  updateShopperProfile,
  updateShopperPassword
} = proxyActivities<Identity.IdentityActivities>({
  startToCloseTimeout: '10s',
  retry: {
    maximumAttempts: 3
  }
});
