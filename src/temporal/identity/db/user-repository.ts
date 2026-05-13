import { executeCql, createLogger } from '../../../lib';
import type { Identity } from '../../contracts';
import { types } from 'cassandra-driver';

const logger = createLogger('identity:user-repository');

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

export class UserRepository {
  async getUserByEmail(email: string): Promise<Identity.User | null> {
    logger.info({ email }, 'UserRepository.getUserByEmail');

    const rows = await executeCql<{
      id: types.Uuid;
      email: string;
      password_hash: string;
      name: string;
      role: string;
      failed_attempts: number | null;
      locked_until: Date | null;
    }>(
      `SELECT id, email, password_hash, name, role, failed_attempts, locked_until 
       FROM users 
       WHERE email = ?`,
      [email]
    );

    if (rows.length === 0) {
      return null;
    }

    const row = rows[0];
    return {
      id: row.id.toString(),
      email: row.email,
      passwordHash: row.password_hash,
      name: row.name,
      role: row.role as 'admin' | 'developer' | 'user',
      failedAttempts: row.failed_attempts || 0,
      lockedUntil: row.locked_until || null
    };
  }

  async getAllUsers(roleFilter?: ('admin' | 'developer' | 'user')[]): Promise<Identity.User[]> {
    logger.info({ roleFilter }, 'UserRepository.getAllUsers');

    const rows = await executeCql<{
      id: types.Uuid;
      email: string;
      password_hash: string;
      name: string;
      role: string;
      failed_attempts: number | null;
      locked_until: Date | null;
    }>(
      `SELECT id, email, password_hash, name, role, failed_attempts, locked_until FROM users`
    );

    let users = rows.map(row => ({
      id: row.id.toString(),
      email: row.email,
      passwordHash: row.password_hash,
      name: row.name,
      role: row.role as 'admin' | 'developer' | 'user',
      failedAttempts: row.failed_attempts || 0,
      lockedUntil: row.locked_until || null
    }));

    // Filter by role if specified
    if (roleFilter && roleFilter.length > 0) {
      users = users.filter(u => roleFilter.includes(u.role));
    }

    return users;
  }

  async updateName(email: string, name: string): Promise<void> {
    logger.info({ email, name }, 'UserRepository.updateName');
    const now = new Date();

    await executeCql(
      `UPDATE users SET name = ?, updated_at = ? WHERE email = ?`,
      [name, now, email]
    );
  }

  async deleteUser(email: string): Promise<void> {
    logger.info({ email }, 'UserRepository.deleteUser');
    await executeCql(`DELETE FROM users WHERE email = ?`, [email]);
  }

  async createUser(user: Identity.User): Promise<void> {
    logger.info({ email: user.email }, 'UserRepository.createUser');
    const now = new Date();

    await executeCql(
      `INSERT INTO users (id, email, password_hash, name, role, failed_attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        user.id,
        user.email,
        user.passwordHash,
        user.name,
        user.role,
        0,
        now,
        now
      ]
    );
  }

  async updatePassword(email: string, newHash: string): Promise<void> {
    logger.info({ email }, 'UserRepository.updatePassword');
    const now = new Date();

    await executeCql(
      `UPDATE users 
       SET password_hash = ?, updated_at = ?, failed_attempts = 0, locked_until = null
       WHERE email = ?`,
      [newHash, now, email]
    );
  }

  async updateRole(email: string, role: 'admin' | 'developer' | 'user'): Promise<void> {
    logger.info({ email, role }, 'UserRepository.updateRole');
    const now = new Date();

    await executeCql(
      `UPDATE users 
       SET role = ?, updated_at = ?
       WHERE email = ?`,
      [role, now, email]
    );
  }

  async updateEmail(oldEmail: string, newEmail: string): Promise<void> {
    logger.info({ oldEmail, newEmail }, 'UserRepository.updateEmail');
    
    // Check if new email already exists
    const existing = await this.getUserByEmail(newEmail);
    if (existing) {
      throw new Error('Email already in use');
    }
    
    // Get the current user
    const user = await this.getUserByEmail(oldEmail);
    if (!user) {
      throw new Error('User not found');
    }
    
    const now = new Date();
    
    // Insert with new email (Cassandra uses email as primary key)
    await executeCql(
      `INSERT INTO users (id, email, password_hash, name, role, failed_attempts, locked_until, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        user.id,
        newEmail,
        user.passwordHash,
        user.name,
        user.role,
        user.failedAttempts || 0,
        user.lockedUntil || null,
        now, // created_at for new row
        now
      ]
    );
    
    // Delete old email row
    await executeCql(`DELETE FROM users WHERE email = ?`, [oldEmail]);
  }

  // Account Lockout Methods

  async incrementFailedAttempts(email: string): Promise<number> {
    logger.info({ email }, 'UserRepository.incrementFailedAttempts');
    const now = new Date();

    // Get current attempts
    const user = await this.getUserByEmail(email);
    if (!user) return 0;

    const newAttempts = (user.failedAttempts || 0) + 1;

    // Check if we should lock the account
    if (newAttempts >= LOCKOUT_THRESHOLD) {
      const lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS);
      await executeCql(
        `UPDATE users 
         SET failed_attempts = ?, locked_until = ?, updated_at = ?
         WHERE email = ?`,
        [newAttempts, lockedUntil, now, email]
      );
      logger.warn({ email, lockedUntil }, 'Account locked due to too many failed attempts');
    } else {
      await executeCql(
        `UPDATE users 
         SET failed_attempts = ?, updated_at = ?
         WHERE email = ?`,
        [newAttempts, now, email]
      );
    }

    return newAttempts;
  }

  async resetFailedAttempts(email: string): Promise<void> {
    logger.info({ email }, 'UserRepository.resetFailedAttempts');
    const now = new Date();

    await executeCql(
      `UPDATE users 
       SET failed_attempts = 0, locked_until = null, updated_at = ?
       WHERE email = ?`,
      [now, email]
    );
  }

  isAccountLocked(user: Identity.User): boolean {
    if (!user.lockedUntil) return false;
    return new Date(user.lockedUntil) > new Date();
  }

  getLockoutRemainingSeconds(user: Identity.User): number {
    if (!user.lockedUntil) return 0;
    const remaining = new Date(user.lockedUntil).getTime() - Date.now();
    return Math.max(0, Math.ceil(remaining / 1000));
  }

  // Password Reset Token Methods

  async createPasswordResetToken(email: string, token: string, expiresAt: Date): Promise<void> {
    logger.info({ email }, 'UserRepository.createPasswordResetToken');
    const now = new Date();

    await executeCql(
      `INSERT INTO password_reset_tokens (reset_token, email, expires_at, used, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [token, email, expiresAt, false, now]
    );
  }

  async getPasswordResetToken(token: string): Promise<Identity.PasswordResetToken | null> {
    logger.info('UserRepository.getPasswordResetToken');

    const rows = await executeCql<{
      reset_token: string;
      email: string;
      expires_at: Date;
      used: boolean;
    }>(
      `SELECT reset_token, email, expires_at, used 
       FROM password_reset_tokens 
       WHERE reset_token = ?`,
      [token]
    );

    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      token: row.reset_token,
      email: row.email,
      expiresAt: row.expires_at,
      used: row.used
    };
  }

  async markTokenAsUsed(token: string): Promise<void> {
    logger.info('UserRepository.markTokenAsUsed');

    await executeCql(`UPDATE password_reset_tokens SET used = true WHERE reset_token = ?`, [token]);
  }
}
