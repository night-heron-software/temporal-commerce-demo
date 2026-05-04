import { executeCql, createLogger } from '../../../lib';
import type { Identity } from '../../contracts';
import { types } from 'cassandra-driver';

const logger = createLogger('identity:store-repository');

/**
 * Repository for Cassandra stores and store_domains operations.
 */
export class StoreRepository {

  async getStoreById(storeId: string): Promise<Identity.Store | null> {
    logger.info({ storeId }, 'StoreRepository.getStoreById');

    const rows = await executeCql<{
      id: types.Uuid;
      name: string;
      slug: string;
      status: string;
      owner_email: string | null;
      created_at: Date;
      updated_at: Date;
    }>('SELECT id, name, slug, status, owner_email, created_at, updated_at FROM stores WHERE id = ?', [
      storeId,
    ]);

    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      id: row.id.toString(),
      name: row.name,
      slug: row.slug,
      status: row.status as Identity.Store['status'],
      ownerEmail: row.owner_email,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async getStoreByDomain(domain: string): Promise<Identity.Store | null> {
    logger.info({ domain }, 'StoreRepository.getStoreByDomain');

    const domainRows = await executeCql<{
      domain: string;
      store_id: types.Uuid;
      is_primary: boolean;
      verified: boolean;
      created_at: Date;
    }>('SELECT domain, store_id, is_primary, verified, created_at FROM store_domains WHERE domain = ?', [domain]);

    if (domainRows.length === 0) return null;

    const storeId = domainRows[0].store_id.toString();
    return this.getStoreById(storeId);
  }

  async listStores(): Promise<Identity.Store[]> {
    logger.info('StoreRepository.listStores');

    const rows = await executeCql<{
      id: types.Uuid;
      name: string;
      slug: string;
      status: string;
      owner_email: string | null;
      created_at: Date;
      updated_at: Date;
    }>('SELECT id, name, slug, status, owner_email, created_at, updated_at FROM stores');

    return rows.map((row) => ({
      id: row.id.toString(),
      name: row.name,
      slug: row.slug,
      status: row.status as Identity.Store['status'],
      ownerEmail: row.owner_email,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async createStore(store: Omit<Identity.Store, 'createdAt' | 'updatedAt'>): Promise<void> {
    logger.info({ storeId: store.id, name: store.name }, 'StoreRepository.createStore');

    const now = new Date();
    await executeCql(
      `INSERT INTO stores (id, name, slug, status, owner_email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [store.id, store.name, store.slug, store.status, store.ownerEmail, now, now]
    );
  }

  async updateStore(storeId: string, updates: Partial<Pick<Identity.Store, 'name' | 'slug' | 'status' | 'ownerEmail'>>): Promise<void> {
    logger.info({ storeId, updates }, 'StoreRepository.updateStore');

    const setClauses: string[] = [];
    const params: unknown[] = [];

    if (updates.name !== undefined) { setClauses.push('name = ?'); params.push(updates.name); }
    if (updates.slug !== undefined) { setClauses.push('slug = ?'); params.push(updates.slug); }
    if (updates.status !== undefined) { setClauses.push('status = ?'); params.push(updates.status); }
    if (updates.ownerEmail !== undefined) { setClauses.push('owner_email = ?'); params.push(updates.ownerEmail); }

    if (setClauses.length === 0) return;

    setClauses.push('updated_at = ?');
    params.push(new Date());
    params.push(storeId);

    await executeCql(
      `UPDATE stores SET ${setClauses.join(', ')} WHERE id = ?`,
      params
    );
  }

  async getDomainsForStore(storeId: string): Promise<Identity.StoreDomain[]> {
    logger.info({ storeId }, 'StoreRepository.getDomainsForStore');

    const rows = await executeCql<{
      domain: string;
      store_id: types.Uuid;
      is_primary: boolean;
      verified: boolean;
      created_at: Date;
    }>(
      'SELECT domain, store_id, is_primary, verified, created_at FROM store_domains WHERE store_id = ?',
      [storeId]
    );

    return rows.map((row) => ({
      domain: row.domain,
      storeId: row.store_id.toString(),
      isPrimary: row.is_primary,
      verified: row.verified,
      createdAt: row.created_at,
    }));
  }

  async addDomain(domain: string, storeId: string, isPrimary: boolean = false): Promise<void> {
    logger.info({ domain, storeId, isPrimary }, 'StoreRepository.addDomain');

    await executeCql(
      `INSERT INTO store_domains (domain, store_id, is_primary, verified, created_at) VALUES (?, ?, ?, ?, ?)`,
      [domain, storeId, isPrimary, true, new Date()]
    );
  }

  async removeDomain(domain: string): Promise<void> {
    logger.info({ domain }, 'StoreRepository.removeDomain');

    await executeCql('DELETE FROM store_domains WHERE domain = ?', [domain]);
  }
}
