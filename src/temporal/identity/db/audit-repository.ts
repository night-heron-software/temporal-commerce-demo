import { executeCql, createLogger } from '../../../lib';
import type { Identity } from '../../contracts';
import { types } from 'cassandra-driver';

const logger = createLogger('identity:audit-repository');

export class AuditRepository {
  /**
   * Log a privileged action to the audit trail.
   */
  async log(storeId: string, entry: Identity.AuditEntry): Promise<void> {
    logger.info({ storeId, action: entry.action, actor: entry.actorEmail }, 'AuditRepository.log');

    const now = new Date();
    // Use CQL now() for timeuuid — avoids cross-instance cassandra-driver type issues

    await executeCql(
      `INSERT INTO audit_log (
        store_id, id, actor_email, actor_role, impersonating_as, action, 
        target_email, target_resource, metadata, ip_address, created_at
      ) VALUES (?, now(), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        storeId,
        entry.actorEmail,
        entry.actorRole,
        entry.impersonatingAs || null,
        entry.action,
        entry.targetEmail || null,
        entry.targetResource || null,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
        entry.ipAddress || null,
        now
      ]
    );
  }

  /**
   * Get recent audit entries for a specific actor.
   */
  async getByActor(storeId: string, actorEmail: string, limit: number = 50): Promise<Identity.AuditEntry[]> {
    logger.info({ storeId, actorEmail }, 'AuditRepository.getByActor');

    const rows = await executeCql<{
      id: types.TimeUuid;
      actor_email: string;
      actor_role: string;
      impersonating_as: string | null;
      action: string;
      target_email: string | null;
      target_resource: string | null;
      metadata: string | null;
      ip_address: string | null;
      created_at: Date;
    }>(
      `SELECT id, actor_email, actor_role, impersonating_as, action, 
              target_email, target_resource, metadata, ip_address, created_at 
       FROM audit_log 
       WHERE store_id = ? AND actor_email = ? 
       LIMIT ?`,
      [storeId, actorEmail, limit]
    );

    return rows.map((row) => ({
      id: row.id.toString(),
      actorEmail: row.actor_email,
      actorRole: row.actor_role,
      impersonatingAs: row.impersonating_as || undefined,
      action: row.action as Identity.AuditAction,
      targetEmail: row.target_email || undefined,
      targetResource: row.target_resource || undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      ipAddress: row.ip_address || undefined,
      createdAt: row.created_at
    }));
  }

  /**
   * Get recent audit entries targeting a specific user.
   */
  async getByTarget(storeId: string, targetEmail: string, limit: number = 50): Promise<Identity.AuditEntry[]> {
    logger.info({ storeId, targetEmail }, 'AuditRepository.getByTarget');

    const rows = await executeCql<{
      id: types.TimeUuid;
      actor_email: string;
      actor_role: string;
      impersonating_as: string | null;
      action: string;
      target_email: string | null;
      target_resource: string | null;
      metadata: string | null;
      ip_address: string | null;
      created_at: Date;
    }>(
      `SELECT id, actor_email, actor_role, impersonating_as, action, 
              target_email, target_resource, metadata, ip_address, created_at 
       FROM audit_log 
       WHERE store_id = ? AND target_email = ? 
       LIMIT ?`,
      [storeId, targetEmail, limit]
    );

    return rows.map((row) => ({
      id: row.id.toString(),
      actorEmail: row.actor_email,
      actorRole: row.actor_role,
      impersonatingAs: row.impersonating_as || undefined,
      action: row.action as Identity.AuditAction,
      targetEmail: row.target_email || undefined,
      targetResource: row.target_resource || undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      ipAddress: row.ip_address || undefined,
      createdAt: row.created_at
    }));
  }
}
