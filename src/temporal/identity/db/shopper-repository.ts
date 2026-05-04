import { executeCql, createLogger } from '../../../lib';
import type { Identity } from '../../contracts';
import { types } from 'cassandra-driver';
import bcrypt from 'bcryptjs';

const logger = createLogger('identity:shopper-repository');

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

export class ShopperRepository {
  async getShopperByEmail(storeId: string, email: string): Promise<Identity.Shopper | null> {
    logger.info({ storeId, email }, 'ShopperRepository.getShopperByEmail');

    const rows = await executeCql<{
      id: types.Uuid;
      email: string;
      password_hash: string;
      name: string;
      phone: string | null;
      failed_attempts: number | null;
      locked_until: Date | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, email, password_hash, name, phone, failed_attempts, locked_until, created_at, updated_at
       FROM shoppers
       WHERE store_id = ? AND email = ?`,
      [storeId, email]
    );

    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      id: row.id.toString(),
      email: row.email,
      passwordHash: row.password_hash,
      name: row.name,
      phone: row.phone || undefined,
      failedAttempts: row.failed_attempts || 0,
      lockedUntil: row.locked_until || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  async createShopper(storeId: string, shopper: {
    id: string;
    email: string;
    passwordHash: string;
    name: string;
    phone?: string;
  }): Promise<void> {
    logger.info({ storeId, email: shopper.email }, 'ShopperRepository.createShopper');
    const now = new Date();

    await executeCql(
      `INSERT INTO shoppers (store_id, id, email, password_hash, name, phone, failed_attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        storeId,
        shopper.id,
        shopper.email,
        shopper.passwordHash,
        shopper.name,
        shopper.phone || null,
        0,
        now,
        now
      ]
    );
  }

  async updatePassword(storeId: string, email: string, newHash: string): Promise<void> {
    logger.info({ storeId, email }, 'ShopperRepository.updatePassword');
    const now = new Date();

    await executeCql(
      `UPDATE shoppers 
       SET password_hash = ?, updated_at = ?, failed_attempts = 0, locked_until = null
       WHERE store_id = ? AND email = ?`,
      [newHash, now, storeId, email]
    );
  }

  async recordFailedLogin(storeId: string, email: string): Promise<{ locked: boolean; attempts: number }> {
    logger.info({ storeId, email }, 'ShopperRepository.recordFailedLogin');
    
    const shopper = await this.getShopperByEmail(storeId, email);
    if (!shopper) return { locked: false, attempts: 0 };

    const newAttempts = (shopper.failedAttempts || 0) + 1;
    const now = new Date();

    if (newAttempts >= LOCKOUT_THRESHOLD) {
      const lockUntil = new Date(Date.now() + LOCKOUT_DURATION_MS);
      await executeCql(
        `UPDATE shoppers 
         SET failed_attempts = ?, locked_until = ?, updated_at = ?
         WHERE store_id = ? AND email = ?`,
        [newAttempts, lockUntil, now, storeId, email]
      );
      return { locked: true, attempts: newAttempts };
    }

    await executeCql(
      `UPDATE shoppers 
       SET failed_attempts = ?, updated_at = ?
       WHERE store_id = ? AND email = ?`,
      [newAttempts, now, storeId, email]
    );
    return { locked: false, attempts: newAttempts };
  }

  async clearFailedLogins(storeId: string, email: string): Promise<void> {
    logger.info({ storeId, email }, 'ShopperRepository.clearFailedLogins');
    const now = new Date();

    await executeCql(
      `UPDATE shoppers 
       SET failed_attempts = 0, locked_until = null, updated_at = ?
       WHERE store_id = ? AND email = ?`,
      [now, storeId, email]
    );
  }

  async isAccountLocked(storeId: string, email: string): Promise<boolean> {
    const shopper = await this.getShopperByEmail(storeId, email);
    if (!shopper || !shopper.lockedUntil) return false;
    return shopper.lockedUntil > new Date();
  }

  async validatePassword(storeId: string, email: string, password: string): Promise<Identity.Shopper | null> {
    const shopper = await this.getShopperByEmail(storeId, email);
    if (!shopper) return null;

    // Check if account is locked
    if (shopper.lockedUntil && shopper.lockedUntil > new Date()) {
      logger.warn({ storeId, email }, 'Shopper account is locked');
      return null;
    }

    const isValid = await bcrypt.compare(password, shopper.passwordHash);
    
    if (!isValid) {
      await this.recordFailedLogin(storeId, email);
      return null;
    }

    // Clear failed attempts on successful login
    await this.clearFailedLogins(storeId, email);
    return shopper;
  }

  async getAllShoppers(storeId: string): Promise<Array<{ id: string; email: string; name: string; phone?: string; createdAt?: Date }>> {
    logger.info({ storeId }, 'ShopperRepository.getAllShoppers');

    const rows = await executeCql<{
      id: types.Uuid;
      email: string;
      name: string;
      phone: string | null;
      created_at: Date;
    }>(
      `SELECT id, email, name, phone, created_at FROM shoppers WHERE store_id = ?`,
      [storeId]
    );

    return rows.map((row) => ({
      id: row.id.toString(),
      email: row.email,
      name: row.name,
      phone: row.phone || undefined,
      createdAt: row.created_at
    }));
  }

  async updateShopper(storeId: string, email: string, updates: { name?: string; phone?: string }): Promise<void> {
    logger.info({ storeId, email, updates }, 'ShopperRepository.updateShopper');
    const now = new Date();

    const setClauses: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];

    if (updates.name !== undefined) {
      setClauses.push('name = ?');
      params.push(updates.name);
    }
    if (updates.phone !== undefined) {
      setClauses.push('phone = ?');
      params.push(updates.phone);
    }

    params.push(storeId);
    params.push(email);

    await executeCql(
      `UPDATE shoppers SET ${setClauses.join(', ')} WHERE store_id = ? AND email = ?`,
      params
    );
  }

  /**
   * Search shoppers by email or name substring.
   * Returns basic info without sensitive data (password hash, etc.)
   */
  async searchShoppers(
    storeId: string,
    query: string,
    limit: number = 10
  ): Promise<Array<{ id: string; email: string; name: string }>> {
    logger.info({ storeId, query, limit }, 'ShopperRepository.searchShoppers');

    if (!query || query.trim().length === 0) {
      return [];
    }

    const normalizedQuery = query.toLowerCase().trim();

    // Cassandra doesn't support LIKE queries well, so we fetch all and filter in-memory
    // For production scale, this would need to use a search index like Elasticsearch
    const rows = await executeCql<{
      id: types.Uuid;
      email: string;
      name: string;
    }>(
      `SELECT id, email, name FROM shoppers WHERE store_id = ?`,
      [storeId]
    );

    const filtered = rows
      .filter(
        (row) =>
          row.email.toLowerCase().includes(normalizedQuery) ||
          row.name.toLowerCase().includes(normalizedQuery)
      )
      .slice(0, limit)
      .map((row) => ({
        id: row.id.toString(),
        email: row.email,
        name: row.name
      }));

    return filtered;
  }
}
