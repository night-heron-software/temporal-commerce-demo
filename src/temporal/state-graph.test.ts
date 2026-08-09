/**
 * Assertions over the generated state graph (docs/reference/state-graph.json).
 *
 * The graph is produced by `npm run docs:diagrams` via static AST analysis of the
 * domain states files; CI regenerates and `--check`s it, so these tests run against a
 * guaranteed-fresh snapshot. They make structural properties of every machine —
 * "the expected machines exist", "no orphan states", "every waiting state can move" —
 * queryable instead of eyeballed. Aligned with the mono's graph-integrity suite
 * (schemaVersion 2, ADR-0024: unique machine `id`, per-state `commands`, 'event' kind).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

interface Transition {
  on: string;
  kind: string;
  to: string;
}
interface MachineState {
  name: string;
  transitional?: boolean;
  transitions: Transition[];
}
interface Machine {
  id: string;
  domain: string;
  registry: string;
  initialState: string;
  terminals: string[];
  states: MachineState[];
}
interface CrossEdge {
  from: string;
  to: string;
  kind: string;
  label: string;
}
interface StateGraph {
  schemaVersion: number;
  machines: Machine[];
  crossDomain: CrossEdge[];
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GRAPH_PATH = path.join(ROOT, 'docs/reference/state-graph.json');
const graph: StateGraph = JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf-8'));

const EXPECTED_REGISTRIES = [
  'CART_STATES',
  'CHECKOUT_STATES',
  'OMS_STATES',
  'FULFILLMENT_STATES',
  'FULFILLER_ORDER_STATES',
];

/**
 * Known pre-existing orphan (unreachable) live states — a ratchet: a NEW orphan fails
 * the suite; documented ones are tolerated until the domain decides their fate.
 * Currently empty.
 */
const KNOWN_ORPHANS = new Set<string>([]);

/** States reachable from `initialState` by following non-terminal transition targets. */
function reachableStates(machine: Machine): Set<string> {
  const adjacency = new Map<string, string[]>();
  for (const s of machine.states) {
    adjacency.set(
      s.name,
      s.transitions.filter((t) => !t.to.startsWith('__terminal:')).map((t) => t.to),
    );
  }
  const seen = new Set<string>([machine.initialState]);
  const queue = [machine.initialState];
  while (queue.length > 0) {
    const node = queue.shift() as string;
    for (const next of adjacency.get(node) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

describe('state-graph.json — schema', () => {
  it('is schemaVersion 2 with machines[] and crossDomain[]', () => {
    // v2 (ADR-0024): unique machine `id`, optional per-state `commands`, 'event' kind.
    expect(graph.schemaVersion).toBe(2);
    expect(Array.isArray(graph.machines)).toBe(true);
    expect(graph.machines.length).toBeGreaterThan(0);
    expect(Array.isArray(graph.crossDomain)).toBe(true);
  });

  it('contains every expected domain machine', () => {
    const registries = graph.machines.map((m) => m.registry).sort();
    expect(registries).toEqual([...EXPECTED_REGISTRIES].sort());
  });

  it('machine ids are unique (domain names are not — fulfillment owns two machines)', () => {
    const ids = graph.machines.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe.each(graph.machines.map((m) => [m.registry, m] as const))(
  'integrity — %s',
  (_registry, machine) => {
    const names = new Set<string>(machine.states.map((s) => s.name));

    it('initialState is a declared state', () => {
      expect(names.has(machine.initialState)).toBe(true);
    });

    it('every non-transitional state has an outgoing transition', () => {
      for (const state of machine.states) {
        if (state.transitional) continue;
        expect(
          state.transitions.length,
          `state '${state.name}' has no outgoing edges`,
        ).toBeGreaterThan(0);
      }
    });

    it('every transition target is a declared state or a terminal', () => {
      const dangling: string[] = [];
      for (const s of machine.states) {
        for (const t of s.transitions) {
          if (!t.to.startsWith('__terminal:') && !names.has(t.to)) {
            dangling.push(`${s.name} --${t.on}--> ${t.to}`);
          }
        }
      }
      expect(dangling).toEqual([]);
    });

    it('every declared terminal reason is targeted by some transition', () => {
      const targeted = new Set<string>();
      for (const s of machine.states) {
        for (const t of s.transitions) {
          if (t.to.startsWith('__terminal:')) targeted.add(t.to.slice('__terminal:'.length));
        }
      }
      for (const reason of machine.terminals) expect(targeted.has(reason)).toBe(true);
    });

    it('has no unexpected orphan (unreachable) states', () => {
      const seen = reachableStates(machine);
      const orphans = machine.states
        .map((s: { name: string }) => s.name)
        .filter((n: string) => !seen.has(n) && !KNOWN_ORPHANS.has(`${machine.registry}.${n}`));
      expect(orphans).toEqual([]);
    });
  },
);

/**
 * Decide-test coverage (mono gen-2 Phase 3.2, unconditional). A state is considered
 * "covered" if a `*.test.ts` in its own domain directory names it as a quoted string OR
 * invokes it via the canonical `<REGISTRY>.<state>.fn(` pattern. This is a presence
 * check, not proof the decider is asserted — but a state exercised by neither is
 * certainly untested.
 */

/** Concatenated `*.test.ts` source for a domain directory (empty string if none). */
function domainTestSource(domain: string): string {
  const dir = path.join(ROOT, 'src/temporal', domain);
  if (!fs.existsSync(dir)) return '';
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf-8'))
    .join('\n');
}

describe('decide-test coverage', () => {
  it('every state machine state has a co-located decide test', () => {
    const untested: string[] = [];
    for (const m of graph.machines) {
      const tests = domainTestSource(m.domain);
      for (const s of m.states) {
        const covered =
          tests.includes(`'${s.name}'`) ||
          tests.includes(`"${s.name}"`) ||
          tests.includes(`.${s.name}.fn`);
        if (!covered) untested.push(`${m.registry}.${s.name}`);
      }
    }
    expect(untested).toEqual([]);
  });
});

describe('cross-domain orchestration edges', () => {
  const domains = new Set<string>(graph.machines.map((m: { domain: string }) => m.domain));

  it('every edge endpoint is a domain that owns a machine', () => {
    const bad: string[] = [];
    for (const e of graph.crossDomain) {
      if (!domains.has(e.from)) bad.push(`unknown from-domain '${e.from}'`);
      if (!domains.has(e.to)) bad.push(`unknown to-domain '${e.to}'`);
    }
    expect(bad).toEqual([]);
  });

  it('has no self-loop (intra-domain) edges — those are dropped by the generator', () => {
    const selfLoops = graph.crossDomain.filter(
      (e: { from: string; to: string }) => e.from === e.to,
    );
    expect(selfLoops).toEqual([]);
  });
});
