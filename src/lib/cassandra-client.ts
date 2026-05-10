/**
 * Cassandra Client — Environment-adaptive connection
 *
 * Connects to local Docker container or cloud Cassandra (Astra DB / AWS Keyspaces)
 * based on env vars.
 */

import { Client, types } from 'cassandra-driver';

/** Re-export cassandra-driver types for domain code (TimeUuid, Uuid, etc.) */
export const cassandraTypes = types;

const CONTACT_POINTS = (process.env.CASSANDRA_CONTACT_POINTS || 'localhost:9042').split(',');
const KEYSPACE = process.env.CASSANDRA_KEYSPACE || 'catalog';
const USE_TLS = process.env.CASSANDRA_USE_TLS === 'true';

let cachedClient: Client | null = null;

function createClient(): Client {
  const clientOptions: ConstructorParameters<typeof Client>[0] = {
    contactPoints: CONTACT_POINTS,
    localDataCenter: process.env.CASSANDRA_DC || 'dc1',
    keyspace: KEYSPACE,
  };

  if (USE_TLS) {
    clientOptions.sslOptions = {};
    if (process.env.CASSANDRA_SECURE_BUNDLE_PATH) {
      clientOptions.cloud = {
        secureConnectBundle: process.env.CASSANDRA_SECURE_BUNDLE_PATH,
      };
      delete clientOptions.contactPoints;
      delete clientOptions.localDataCenter;
    }
  }

  if (process.env.CASSANDRA_USERNAME && process.env.CASSANDRA_PASSWORD) {
    clientOptions.credentials = {
      username: process.env.CASSANDRA_USERNAME,
      password: process.env.CASSANDRA_PASSWORD,
    };
  }

  return new Client(clientOptions);
}

export function getCassandraClient(): Client {
  if (!cachedClient) {
    cachedClient = createClient();
  }
  return cachedClient;
}

/**
 * Execute a CQL query and return typed rows (first page only — default 5000).
 * Use executeCqlAll for full table scans with 5000+ rows.
 */
export async function executeCql<T = Record<string, unknown>>(
  query: string,
  params?: unknown[],
): Promise<T[]> {
  const client = getCassandraClient();
  const result = await client.execute(query, params, { prepare: true });
  return result.rows as unknown as T[];
}

/**
 * Execute a CQL query and return ALL rows by auto-paging through the result set.
 * Use this for full table scans where row count may exceed the default fetchSize (5000).
 */
export async function executeCqlAll<T = Record<string, unknown>>(
  query: string,
  params?: unknown[],
): Promise<T[]> {
  const client = getCassandraClient();
  const result = await client.execute(query, params, { prepare: true, fetchSize: 5000 });
  const allRows: T[] = [];
  for await (const row of result) {
    allRows.push(row as unknown as T);
  }
  return allRows;
}

/**
 * Execute a batch of CQL queries atomically.
 */
export async function executeBatch(
  queries: Array<{ query: string; params?: unknown[] }>,
): Promise<void> {
  const client = getCassandraClient();
  await client.batch(queries, { prepare: true });
}

