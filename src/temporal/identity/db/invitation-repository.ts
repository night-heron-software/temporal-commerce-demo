import { executeCql, createLogger } from '../../../lib';
import type { Identity } from '../../contracts';
import { types } from 'cassandra-driver';
import crypto from 'crypto';

const logger = createLogger('identity:invitation-repository');

export class UserInvitationRepository {
  /**
   * Create a new invitation.
   */
  async createInvitation(input: Identity.CreateInvitationInput): Promise<Identity.UserInvitation> {
    logger.info({ email: input.email, role: input.role }, 'UserInvitationRepository.createInvitation');

    // Generate a secure token for the invitation URL
    const token = crypto.randomBytes(32).toString('hex');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (input.expiresInDays || 7) * 24 * 60 * 60 * 1000);

    await executeCql(
      `INSERT INTO user_invitations (invitation_token, email, role, invited_by, expires_at, accepted, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [token, input.email, input.role, input.invitedBy, expiresAt, false, now]
    );

    return {
      token,
      email: input.email,
      role: input.role,
      invitedBy: input.invitedBy,
      expiresAt,
      accepted: false,
      createdAt: now
    };
  }

  /**
   * Get an invitation by token.
   */
  async getInvitationByToken(token: string): Promise<Identity.UserInvitation | null> {
    logger.info('UserInvitationRepository.getInvitationByToken');

    const rows = await executeCql<{
      invitation_token: string;
      email: string;
      role: string;
      invited_by: string;
      expires_at: Date;
      accepted: boolean;
      created_at: Date;
    }>(`SELECT invitation_token, email, role, invited_by, expires_at, accepted, created_at FROM user_invitations WHERE invitation_token = ?`, [token]);

    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      token: row.invitation_token,
      email: row.email,
      role: row.role as 'admin' | 'developer' | 'staff',
      invitedBy: row.invited_by,
      expiresAt: row.expires_at,
      accepted: row.accepted,
      createdAt: row.created_at
    };
  }

  /**
   * Get pending invitations for an email.
   * Can optionally filter by store.
   */
  async getPendingInvitationsByEmail(email: string): Promise<Identity.UserInvitation[]> {
    logger.info({ email }, 'UserInvitationRepository.getPendingInvitationsByEmail');

    const rows = await executeCql<{
      invitation_token: string;
      email: string;
      role: string;
      invited_by: string;
      expires_at: Date;
      accepted: boolean;
      created_at: Date;
    }>(`SELECT invitation_token, email, role, invited_by, expires_at, accepted, created_at FROM user_invitations WHERE email = ?`, [email]);

    const invitations = rows
      .filter((row) => !row.accepted && new Date(row.expires_at) > new Date())
      .map((row) => ({
        token: row.invitation_token,
        email: row.email,
        role: row.role as 'admin' | 'developer' | 'staff',
        invitedBy: row.invited_by,
        expiresAt: row.expires_at,
        accepted: row.accepted,
        createdAt: row.created_at
      }));

    return invitations;
  }

  /**
   * Mark an invitation as accepted.
   */
  async acceptInvitation(token: string): Promise<boolean> {
    logger.info({ token }, 'UserInvitationRepository.acceptInvitation');

    try {
      await executeCql(`UPDATE user_invitations SET accepted = true WHERE invitation_token = ?`, [token]);
      return true;
    } catch (error) {
      logger.error({ error, token }, 'Failed to accept invitation');
      return false;
    }
  }

  /**
   * Get all invitations.
   * Can optionally filter by store.
   */
  async getAllInvitations(limit: number = 100): Promise<Identity.UserInvitation[]> {
    logger.info('UserInvitationRepository.getAllInvitations');

    const rows = await executeCql<{
      invitation_token: string;
      email: string;
      role: string;
      invited_by: string;
      expires_at: Date;
      accepted: boolean;
      created_at: Date;
    }>(`SELECT invitation_token, email, role, invited_by, expires_at, accepted, created_at FROM user_invitations LIMIT ?`, [limit]);

    const invitations = rows.map((row) => ({
      token: row.invitation_token,
      email: row.email,
      role: row.role as 'admin' | 'developer' | 'staff',
      invitedBy: row.invited_by,
      expiresAt: row.expires_at,
      accepted: row.accepted,
      createdAt: row.created_at
    }));

    return invitations;
  }

  /**
   * Delete an invitation.
   */
  async deleteInvitation(token: string): Promise<boolean> {
    logger.info({ token }, 'UserInvitationRepository.deleteInvitation');

    try {
      await executeCql(`DELETE FROM user_invitations WHERE invitation_token = ?`, [token]);
      return true;
    } catch (error) {
      logger.error({ error, token }, 'Failed to delete invitation');
      return false;
    }
  }
}
