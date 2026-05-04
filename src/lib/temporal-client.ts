/**
 * Temporal Client — Environment-adaptive singleton
 *
 * Connects to local dev server or Temporal Cloud based on env vars.
 * Uses mTLS when TEMPORAL_TLS_CERT and TEMPORAL_TLS_KEY are set.
 */

import { Connection, Client } from '@temporalio/client';

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE || 'default';

let cachedClient: Client | null = null;

export async function getTemporalClient(): Promise<Client> {
  if (cachedClient) return cachedClient;

  const tlsCert = process.env.TEMPORAL_TLS_CERT;
  const tlsKey = process.env.TEMPORAL_TLS_KEY;

  const connection = await Connection.connect({
    address: TEMPORAL_ADDRESS,
    tls: tlsCert && tlsKey ? {
      clientCertPair: {
        crt: Buffer.from(tlsCert, 'base64'),
        key: Buffer.from(tlsKey, 'base64'),
      }
    } : undefined,
  });

  cachedClient = new Client({ connection, namespace: TEMPORAL_NAMESPACE });
  return cachedClient;
}
