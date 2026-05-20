/**
 * Identity Domain Contracts
 *
 * Types and activity interfaces for the identity/general domain:
 * shoppers and addresses.
 */

// ============================================================================
// Shopper Types
// ============================================================================

export interface Shopper {
  id: string;
  email: string;
  passwordHash: string;
  name: string;
  phone?: string;
  failedAttempts?: number;
  lockedUntil?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

// ============================================================================
// Address Types
// ============================================================================

export interface SavedAddress {
  addressId: string;
  label: string;
  firstName: string;
  lastName: string;
  address1: string;
  address2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone?: string;
  email: string;
  isDefault: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

// ============================================================================
// Activity Interfaces (Workflow-safe — used with proxyActivities)
// ============================================================================

/** Identity activities — shopper management. */
export interface IdentityActivities {
  createShopper(shopper: { id: string; email: string; passwordHash: string; name: string; phone?: string }): Promise<void>;
  updateShopperProfile(email: string, updates: { name?: string; phone?: string }): Promise<void>;
  updateShopperPassword(email: string, hash: string): Promise<void>;
}

// ============================================================================
// Workflow Type Constants
// ============================================================================

// Shopper Workflows
export const CREATE_SHOPPER_WORKFLOW_TYPE = 'createShopperWorkflow';
export const UPDATE_SHOPPER_PROFILE_WORKFLOW_TYPE = 'updateShopperProfileWorkflow';
export const UPDATE_SHOPPER_PASSWORD_WORKFLOW_TYPE = 'updateShopperPasswordWorkflow';
