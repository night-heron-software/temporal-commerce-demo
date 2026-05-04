import { executeCql, createLogger } from '../../../lib';
import type { Identity } from '../../contracts';

const logger = createLogger('identity:feature-flags-repository');

/**
 * Repository for Cassandra feature_flags operations.
 */
export class FeatureFlagsRepository {
  /**
   * Get all feature flags.
   */
  async getAllFeatureFlags(): Promise<Identity.FeatureFlag[]> {
    logger.info('FeatureFlagsRepository.getAllFeatureFlags');

    const rows = await executeCql<{
      name: string;
      enabled: boolean;
      description: string | null;
      updated_at: Date;
    }>('SELECT name, enabled, description, updated_at FROM feature_flags');

    return rows.map((row) => ({
      name: row.name,
      enabled: row.enabled,
      description: row.description,
      updatedAt: row.updated_at
    }));
  }

  /**
   * Get a single feature flag by name.
   * Returns null if not found.
   */
  async getFeatureFlag(name: string): Promise<Identity.FeatureFlag | null> {
    logger.info({ name }, 'FeatureFlagsRepository.getFeatureFlag');

    const rows = await executeCql<{
      name: string;
      enabled: boolean;
      description: string | null;
      updated_at: Date;
    }>('SELECT name, enabled, description, updated_at FROM feature_flags WHERE name = ?', [name]);

    if (rows.length === 0) {
      return null;
    }

    const row = rows[0];
    return {
      name: row.name,
      enabled: row.enabled,
      description: row.description,
      updatedAt: row.updated_at
    };
  }

  /**
   * Upsert a feature flag.
   */
  async upsertFeatureFlag(flag: Omit<Identity.FeatureFlag, 'updatedAt'>): Promise<void> {
    logger.info({ name: flag.name, enabled: flag.enabled }, 'FeatureFlagsRepository.upsertFeatureFlag');

    const now = new Date();

    await executeCql(
      `INSERT INTO feature_flags (name, enabled, description, updated_at) VALUES (?, ?, ?, ?)`,
      [flag.name, flag.enabled, flag.description ?? null, now]
    );

    logger.info({ name: flag.name }, 'Feature flag upserted successfully');
  }

  /**
   * Delete a feature flag by name.
   */
  async deleteFeatureFlag(name: string): Promise<void> {
    logger.info({ name }, 'FeatureFlagsRepository.deleteFeatureFlag');

    await executeCql(
      `DELETE FROM feature_flags WHERE name = ?`,
      [name]
    );

    logger.info({ name }, 'Feature flag deleted successfully');
  }
}
