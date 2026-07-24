/**
 * Elasticsearch Client — Environment-adaptive connection
 *
 * Connects to local Docker container or cloud ES (OpenSearch / Elastic Cloud)
 * based on env vars.
 */

import { Client } from '@elastic/elasticsearch';

const ES_URL = process.env.ELASTICSEARCH_URL || 'http://localhost:9200';
const ES_API_KEY = process.env.ELASTICSEARCH_API_KEY;

let cachedClient: Client | null = null;

export function getElasticsearchClient(): Client {
  if (!cachedClient) {
    const options: ConstructorParameters<typeof Client>[0] = {
      node: ES_URL,
    };

    if (ES_API_KEY) {
      options.auth = { apiKey: ES_API_KEY };
    }

    cachedClient = new Client(options);
  }
  return cachedClient;
}

/**
 * True when an Elasticsearch error is `index_not_found_exception` — the target index does
 * not exist, typically a transient delete-and-recreate reindexing window. Matched
 * defensively on both the typed response body and the message string, since the client
 * wraps errors differently across transports.
 */
export function isIndexNotFoundError(error: unknown): boolean {
  const e = error as {
    meta?: { body?: { error?: { type?: string } } };
    message?: unknown;
  };
  if (e?.meta?.body?.error?.type === 'index_not_found_exception') return true;
  return typeof e?.message === 'string' && e.message.includes('index_not_found_exception');
}
