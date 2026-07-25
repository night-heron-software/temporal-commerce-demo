'use server';

/**
 * Order Communications — shared Server Action for the order-detail surfaces
 * (admin order detail page, shop order history, and anything else that lists what the
 * customer was told about an order).
 *
 * Reads the `communications` ES projection by orderId, chronological (sentAt asc).
 * Guarded: a missing index (pre-feature deploy) or unreachable ES returns an empty
 * list — an order page must never break over its communications panel.
 */

import { getElasticsearchClient } from '@/lib/es-client';
import { createLogger } from '@/lib/logger';
// Direct module import (not the contracts barrel) — pure module, safe everywhere (PR #41).
import { ES_INDICES, type CommunicationDocument } from '@/temporal/contracts/elasticsearch';

const log = createLogger('order-communications-actions');

export async function getOrderCommunications(orderId: string): Promise<CommunicationDocument[]> {
  try {
    const es = getElasticsearchClient();
    const resp = await es.search<CommunicationDocument>({
      index: ES_INDICES.communications,
      size: 100,
      query: { term: { orderId } },
      sort: [{ sentAt: { order: 'asc' as const } }],
    });
    return resp.hits.hits
      .map((h) => h._source)
      .filter((s): s is CommunicationDocument => Boolean(s));
  } catch (err) {
    log.warn({ err, orderId }, 'Communications lookup failed — returning empty list');
    return [];
  }
}
