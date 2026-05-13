/**
 * Identity Domain Contracts
 *
 * Types and activity interfaces for the identity/general domain:
 * users, shoppers, API tokens, feature flags, audit logging,
 * invitations, stores, and addresses.
 */

// ============================================================================
// User Types
// ============================================================================

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  name: string;
  role: 'admin' | 'developer' | 'user';
  failedAttempts?: number;
  lockedUntil?: Date | null;
}

export interface PasswordResetToken {
  token: string;
  email: string;
  expiresAt: Date;
  used: boolean;
}

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
// API Token Types
// ============================================================================

export type UserType = 'admin' | 'shopper';

export interface ApiToken {
  tokenId: string;
  tokenHash: string;
  name: string;
  userEmail: string;
  userType: UserType;
  scopes: Set<string>;
  expiresAt: Date;
  lastUsedAt: Date | null;
  createdAt: Date;
  revoked: boolean;
}

export interface CreateTokenInput {
  name: string;
  userEmail: string;
  userType?: UserType;
  scopes: string[];
  expiresInDays?: number;
}

export interface TokenValidationResult {
  valid: boolean;
  token?: ApiToken;
  reason?: string;
}

// ============================================================================
// Feature Flag Types
// ============================================================================

export interface FeatureFlag {
  name: string;
  enabled: boolean;
  description: string | null;
  updatedAt: Date;
}

// ============================================================================
// Audit Types
// ============================================================================

export type AuditAction =
  | 'login'
  | 'logout'
  | 'login_failed'
  | 'impersonate_start'
  | 'impersonate_end'
  | 'create_token'
  | 'revoke_token'
  | 'send_invitation'
  | 'accept_invitation'
  | 'delete_invitation'
  | 'change_role'
  | 'reset_password'
  | 'update_email';

export interface AuditEntry {
  id?: string;
  actorEmail: string;
  actorRole: string;
  impersonatingAs?: string;
  action: AuditAction;
  targetEmail?: string;
  targetResource?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  createdAt?: Date;
}

// ============================================================================
// Invitation Types
// ============================================================================

export interface UserInvitation {
  token: string;
  email: string;
  role: 'admin' | 'developer' | 'staff';
  invitedBy: string;
  expiresAt: Date;
  accepted: boolean;
  createdAt: Date;
}

export interface CreateInvitationInput {
  email: string;
  role: 'admin' | 'developer' | 'staff';
  invitedBy: string;
  expiresInDays?: number;
}

// ============================================================================
// Store Types
// ============================================================================

export interface Store {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended' | 'onboarding';
  ownerEmail: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoreDomain {
  domain: string;
  isPrimary: boolean;
  verified: boolean;
  createdAt: Date;
}

// ============================================================================
// Activity Interfaces (Workflow-safe — used with proxyActivities)
// ============================================================================

/** Feature flag activities — used by the identity worker and consumed cross-domain. */
export interface GeneralActivities {
  getFeatureFlag(name: string): Promise<boolean>;
  upsertFeatureFlag(params: { name: string; enabled: boolean; description: string | null }): Promise<void>;
  deleteFeatureFlag(name: string): Promise<void>;
}

/** Identity activities — user, shopper, token, and audit management. */
export interface IdentityActivities {
  createUser(user: User): Promise<void>;
  updateUserName(email: string, name: string): Promise<void>;
  updateUserRole(email: string, role: 'admin' | 'developer' | 'user'): Promise<void>;
  updateUserPassword(email: string, hash: string): Promise<void>;
  deleteUser(email: string): Promise<void>;

  createShopper(shopper: { id: string; email: string; passwordHash: string; name: string; phone?: string }): Promise<void>;
  updateShopperProfile(email: string, updates: { name?: string; phone?: string }): Promise<void>;
  updateShopperPassword(email: string, hash: string): Promise<void>;

  createApiToken(input: CreateTokenInput): Promise<{ rawToken: string; token: Omit<ApiToken, 'scopes'> & { scopes: string[] } }>;
  revokeApiToken(tokenId: string): Promise<boolean>;
  deleteApiToken(tokenId: string): Promise<boolean>;

  logAudit(entry: AuditEntry): Promise<void>;
}

// ============================================================================
// Workflow Type Constants
// ============================================================================

// Feature Flag Workflows
export const UPSERT_FEATURE_FLAG_WORKFLOW_TYPE = 'upsertFeatureFlagWorkflow';
export const DELETE_FEATURE_FLAG_WORKFLOW_TYPE = 'deleteFeatureFlagWorkflow';

// User Workflows
export const CREATE_USER_WORKFLOW_TYPE = 'createUserWorkflow';
export const UPDATE_USER_NAME_WORKFLOW_TYPE = 'updateUserNameWorkflow';
export const UPDATE_USER_ROLE_WORKFLOW_TYPE = 'updateUserRoleWorkflow';
export const UPDATE_USER_PASSWORD_WORKFLOW_TYPE = 'updateUserPasswordWorkflow';
export const DELETE_USER_WORKFLOW_TYPE = 'deleteUserWorkflow';

// Shopper Workflows
export const CREATE_SHOPPER_WORKFLOW_TYPE = 'createShopperWorkflow';
export const UPDATE_SHOPPER_PROFILE_WORKFLOW_TYPE = 'updateShopperProfileWorkflow';
export const UPDATE_SHOPPER_PASSWORD_WORKFLOW_TYPE = 'updateShopperPasswordWorkflow';

// API Token Workflows
export const CREATE_API_TOKEN_WORKFLOW_TYPE = 'createApiTokenWorkflow';
export const REVOKE_API_TOKEN_WORKFLOW_TYPE = 'revokeApiTokenWorkflow';
export const DELETE_API_TOKEN_WORKFLOW_TYPE = 'deleteApiTokenWorkflow';
