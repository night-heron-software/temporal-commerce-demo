/**
 * Structural ratchet for the Cassandra conventions (.agent/rules.md § Cassandra Conventions).
 *
 * Cassandra plays the role Datastore played on App Engine: a store whose query model disallows
 * queries that won't scale. These tests make the conventions mechanical:
 *
 *  1. `ALLOW FILTERING` is banned in source — a query's cost must track its result set, not the
 *     table. If an access pattern needs a different key, add a denormalized table
 *     (see `inventory_reservations_by_status_w`, `orders_by_customer` in cassandra/schema.cql).
 *  2. Secondary indexes are ratcheted to the recorded baseline — adding one fails this test;
 *     removing one requires (deliberately) shrinking the baseline below.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Recursively collect non-test .ts files under a directory. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(p));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

// Split so this file's own source doesn't match the pattern it polices.
const BANNED = 'ALLOW ' + 'FILTERING';

describe('Cassandra conventions (ratchet)', () => {
  it(`no source query uses ${BANNED}`, () => {
    const offenders = [...sourceFiles(path.join(ROOT, 'src')), ...sourceFiles(path.join(ROOT, 'scripts'))]
      .filter((f) => fs.readFileSync(f, 'utf8').toUpperCase().includes(BANNED))
      .map((f) => path.relative(ROOT, f));
    expect(offenders, `queries must supply the partition key; denormalize instead`).toEqual([]);
  });

  it('secondary indexes stay at the recorded baseline', () => {
    // Grandfathered: tiny reference table, not in a hot path. Do not add to this list —
    // new access patterns get denormalized tables keyed for the query.
    const BASELINE = ['idx_fulfiller_locations_is_primary'];
    const schema = fs.readFileSync(path.join(ROOT, 'cassandra', 'schema.cql'), 'utf8');
    const indexes = [...schema.matchAll(/CREATE INDEX(?: IF NOT EXISTS)? (\w+)/gi)]
      .map((m) => m[1])
      .sort();
    expect(indexes).toEqual([...BASELINE].sort());
  });
});
