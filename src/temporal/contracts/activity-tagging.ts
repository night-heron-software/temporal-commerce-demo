/**
 * Standalone-activity correlation tagging (ADR-0006 + ADR-0011).
 *
 * Server-only: imports `@temporalio/common`, so keep this OUT of client components
 * (constants.ts stays dependency-free precisely because client pages import it).
 */

import {
  defineSearchAttributeKey,
  SearchAttributeType,
  type SearchAttributePair,
} from '@temporalio/common';
import { SEARCH_ATTRIBUTE_KEYS, type WorkflowDomain } from './constants';

export interface BuildActivitySearchAttributesInput {
  storeId?: string;
  domain?: WorkflowDomain;
  correlationId?: string;
  orderId?: string;
  cartId?: string;
}

/**
 * Typed Search Attribute pairs for STANDALONE activities (`client.activity.execute`).
 *
 * Standalone activities only accept the typed form (`SearchAttributePair[]`), not the
 * legacy `{ Key: [value] }` map that `buildWorkflowStartOptions` emits — hence this
 * sibling builder. Same keys, same Keyword registration, same defaulting rule
 * (`correlationId` falls back to `cartId`). Tagged activities are queryable in the
 * Temporal UI's **Activities** list (not merged into workflow lists).
 */
export function buildActivityTypedSearchAttributes(
  input: BuildActivitySearchAttributesInput,
): SearchAttributePair[] {
  const { storeId, domain, orderId, cartId } = input;
  const correlationId = input.correlationId ?? cartId;

  const kw = (name: string) => defineSearchAttributeKey(name, SearchAttributeType.KEYWORD);
  const pairs: SearchAttributePair[] = [];
  if (storeId) pairs.push({ key: kw(SEARCH_ATTRIBUTE_KEYS.storeId), value: storeId });
  if (domain) pairs.push({ key: kw(SEARCH_ATTRIBUTE_KEYS.domain), value: domain });
  if (correlationId)
    pairs.push({ key: kw(SEARCH_ATTRIBUTE_KEYS.correlationId), value: correlationId });
  if (orderId) pairs.push({ key: kw(SEARCH_ATTRIBUTE_KEYS.orderId), value: orderId });
  if (cartId) pairs.push({ key: kw(SEARCH_ATTRIBUTE_KEYS.cartId), value: cartId });
  return pairs;
}
