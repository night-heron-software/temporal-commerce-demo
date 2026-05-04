import { executeCql, createLogger } from '../../../lib';
import type { Identity } from '../../contracts';
import { types } from 'cassandra-driver';
import crypto from 'crypto';

const logger = createLogger('identity:api-token-repository');

export class ApiTokenRepository {
  /**
   * Generate a new API token. Returns the raw token (shown only once) and saves the hash.
   */
  async createToken(input: Identity.CreateTokenInput): Promise<{ rawToken: string; token: Identity.ApiToken }> {
    logger.info({ name: input.name, userEmail: input.userEmail, storeId: input.storeId }, 'ApiTokenRepository.createToken');

    // Generate a secure random token
    const rawToken = `nh_${crypto.randomBytes(32).toString('hex')}`;
    
    // Hash it for storage (using SHA-256 for token lookups, not bcrypt since we need fast comparison)
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    
    const tokenId = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (input.expiresInDays || 365) * 24 * 60 * 60 * 1000);

    await executeCql(
      `INSERT INTO api_tokens (token_id, store_id, token_hash, name, user_email, user_type, scopes, expires_at, last_used_at, created_at, revoked)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tokenId,
        input.storeId ? input.storeId : null,
        tokenHash,
        input.name,
        input.userEmail,
        input.userType || 'admin',
        input.scopes, // Cassandra driver expects Array, not Set
        expiresAt,
        null,
        now,
        false
      ]
    );

    const token: Identity.ApiToken = {
      tokenId: tokenId.toString(),
      storeId: input.storeId,
      tokenHash,
      name: input.name,
      userEmail: input.userEmail,
      userType: input.userType || 'admin',
      scopes: new Set(input.scopes),
      expiresAt,
      lastUsedAt: null,
      createdAt: now,
      revoked: false
    };

    return { rawToken, token };
  }

  /**
   * Validate a raw API token. Updates last_used_at on success.
   */
  async validateToken(rawToken: string): Promise<Identity.TokenValidationResult> {
    logger.info('ApiTokenRepository.validateToken');

    if (!rawToken.startsWith('nh_')) {
      return { valid: false, reason: 'Invalid token format' };
    }

    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    const rows = await executeCql<{
      token_id: types.Uuid;
      store_id: types.Uuid | null;
      token_hash: string;
      name: string;
      user_email: string;
      user_type: string | null;
      scopes: Set<string>;
      expires_at: Date;
      last_used_at: Date | null;
      created_at: Date;
      revoked: boolean;
    }>(
      `SELECT token_id, store_id, token_hash, name, user_email, user_type, scopes, expires_at, last_used_at, created_at, revoked 
       FROM api_tokens 
       WHERE token_hash = ?`,
      [tokenHash]
    );

    if (rows.length === 0) {
      return { valid: false, reason: 'Token not found' };
    }

    const row = rows[0];

    if (row.revoked) {
      return { valid: false, reason: 'Token has been revoked' };
    }

    if (new Date(row.expires_at) < new Date()) {
      return { valid: false, reason: 'Token has expired' };
    }

    // Update last_used_at
    await executeCql(
      `UPDATE api_tokens SET last_used_at = ? WHERE token_id = ?`,
      [new Date(), row.token_id]
    );

    const token: Identity.ApiToken = {
      tokenId: row.token_id.toString(),
      storeId: row.store_id ? row.store_id.toString() : undefined,
      tokenHash: row.token_hash,
      name: row.name,
      userEmail: row.user_email,
      userType: (row.user_type as Identity.UserType) || 'admin',
      scopes: row.scopes,
      expiresAt: row.expires_at,
      lastUsedAt: new Date(),
      createdAt: row.created_at,
      revoked: row.revoked
    };

    return { valid: true, token };
  }

  /**
   * Get all tokens for a user.
   */
  async getTokensByUser(userEmail: string, storeId?: string): Promise<Identity.ApiToken[]> {
    logger.info({ userEmail, storeId }, 'ApiTokenRepository.getTokensByUser');

    const rows = await executeCql<{
      token_id: types.Uuid;
      store_id: types.Uuid | null;
      token_hash: string;
      name: string;
      user_email: string;
      user_type: string | null;
      scopes: Set<string>;
      expires_at: Date;
      last_used_at: Date | null;
      created_at: Date;
      revoked: boolean;
    }>(
      `SELECT token_id, store_id, token_hash, name, user_email, user_type, scopes, expires_at, last_used_at, created_at, revoked 
       FROM api_tokens 
       WHERE user_email = ?`,
      [userEmail]
    );

    let tokens = rows.map((row) => ({
      tokenId: row.token_id.toString(),
      storeId: row.store_id ? row.store_id.toString() : undefined,
      tokenHash: row.token_hash,
      name: row.name,
      userEmail: row.user_email,
      userType: (row.user_type as Identity.UserType) || 'admin',
      scopes: row.scopes,
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at,
      createdAt: row.created_at,
      revoked: row.revoked
    }));

    if (storeId) {
      tokens = tokens.filter(t => t.storeId === storeId);
    }

    return tokens;
  }

  /**
   * Revoke a token.
   */
  async revokeToken(tokenId: string): Promise<boolean> {
    logger.info({ tokenId }, 'ApiTokenRepository.revokeToken');

    try {
      await executeCql(`UPDATE api_tokens SET revoked = true WHERE token_id = ?`, [
        tokenId
      ]);
      return true;
    } catch (error) {
      logger.error({ error, tokenId }, 'Failed to revoke token');
      return false;
    }
  }

  /**
   * Delete a token permanently.
   */
  async deleteToken(tokenId: string): Promise<boolean> {
    logger.info({ tokenId }, 'ApiTokenRepository.deleteToken');

    try {
      await executeCql(`DELETE FROM api_tokens WHERE token_id = ?`, [tokenId]);
      return true;
    } catch (error) {
      logger.error({ error, tokenId }, 'Failed to delete token');
      return false;
    }
  }
}
