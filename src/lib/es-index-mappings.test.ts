/**
 * The `system_errors.context` mapping — forward-ported from nightheron-mono, where this exact
 * shape cost real money.
 *
 * `context` is a catch-all bag: `toSystemErrorDocument` sweeps every unrecognised log field into
 * it, so under `dynamic: true` the FIRST document to carry a key fixes that key's type for every
 * document after it. In the mono an earlier numeric `context.status` mapped the field `long`; a
 * later escalation whose `status` was the string `'unmatched_stripe'` was rejected with
 * `document_parsing_exception`, the forwarder swallowed the rejection, and the operator surface
 * reported $0 outstanding while $63.02 sat stranded.
 *
 * The demo had the identical bag and the identical swallow — it had simply never been unlucky
 * with a key. This pins the shape rather than the symptom, because the symptom only appears once
 * two documents disagree, which is far too late to notice.
 */
import { describe, expect, it } from 'vitest';
import { INDEX_MAPPINGS } from './es-index-mappings';

describe('system_errors cannot reject a document for its shape', () => {
  const systemErrors = INDEX_MAPPINGS['system_errors'] as {
    properties: Record<string, Record<string, unknown>>;
  };

  it('maps context as non-indexed, so no document can conflict with a previous one', () => {
    expect(systemErrors.properties.context.enabled).toBe(false);
    // The specific regression: `dynamic: true` is what let one document's type bind the next.
    expect(systemErrors.properties.context.dynamic).toBeFalsy();
  });

  it('CONTROL: the fields the errors view queries on stay indexed', () => {
    // `enabled: false` on `context` must not be mistaken for "stop indexing the document". The
    // dev errors route filters on these, and turning them off would break it silently — a fix
    // that trades one invisible failure for another.
    expect(systemErrors.properties.level.type).toBe('keyword');
    expect(systemErrors.properties.component.type).toBe('keyword');
    expect(systemErrors.properties.message.type).toBe('text');
    expect(systemErrors.properties.correlationId.type).toBe('keyword');
  });

  it('keeps context present, since the errors view reads it out of _source', () => {
    expect(systemErrors.properties).toHaveProperty('context');
  });
});
