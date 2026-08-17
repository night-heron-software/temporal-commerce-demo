/**
 * Assertions over the generated state graph (docs/reference/state-graph.json).
 *
 * The graph is produced by `npm run docs:diagrams` via static AST analysis of the
 * domain states files; CI regenerates and `--check`s it, so these tests run against a
 * guaranteed-fresh snapshot. They make structural properties of every machine —
 * "the expected machines exist", "no orphan states", "every waiting state can move" —
 * queryable instead of eyeballed. Aligned with the mono's graph-integrity suite
 * (schemaVersion 3, ADR-0024 + ADR-0026: unique machine `id`, per-state `commands` with
 * per-command journeys, 'event' kind).
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
interface CommandEmit {
  event: string;
  to: string;
  via: 'explicit' | 'wildcard' | 'unrouted';
  /** The block's own `routes` declaration for this event (ADR-0026), when present. */
  declared?: string;
}
interface StateCommand {
  name: string;
  guarded?: boolean;
  prepareActivities?: string[];
  emits?: CommandEmit[];
}
interface MachineState {
  name: string;
  transitional?: boolean;
  commands?: StateCommand[];
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
  it('is schemaVersion 3 with machines[] and crossDomain[]', () => {
    // v2 (ADR-0024): unique machine `id`, optional per-state `commands`, 'event' kind.
    expect(graph.schemaVersion).toBe(3);
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

// ==================
// Per-command journeys (ADR-0026, schemaVersion 3 — ported from mono #253).
// ==================

describe('per-command journeys (ADR-0026, schemaVersion 3)', () => {
  it('every emitted event resolves to a real state, a declared terminal, or the stay sentinel', () => {
    // The journey join must not invent destinations: each emits.to is a state of the same
    // machine, a terminal the machine declares, or `__self` — this graph's stay sentinel
    // (the demo does not substitute SELF with the state name; the raw sentinel is the
    // convention, pinned by the port's edge-triple invariant).
    const bad: string[] = [];
    for (const m of graph.machines) {
      const names = new Set(m.states.map((s) => s.name));
      for (const s of m.states) {
        for (const c of s.commands ?? []) {
          for (const e of c.emits ?? []) {
            const ok = e.to.startsWith('__terminal:')
              ? m.terminals.includes(e.to.slice('__terminal:'.length))
              : e.to === '__self' || names.has(e.to);
            if (!ok) bad.push(`${m.id}/${s.name}/${c.name}: '${e.event}' → '${e.to}'`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('a block-declared route never disagrees with the state table it lands in', () => {
    // The ADR-0026 drift ratchet. Where a block declares `routes: { X: target }` AND the
    // state's table routes X explicitly, the two must agree — a mismatch means the
    // declaration and the table have drifted, which is exactly the failure mode derivation
    // exists to remove. (via 'wildcard'/'unrouted' with a declaration is the audited
    // weaken-to-stay exception shape: visible in the data, legal here.)
    const drift: string[] = [];
    for (const m of graph.machines) {
      for (const s of m.states) {
        for (const c of s.commands ?? []) {
          for (const e of c.emits ?? []) {
            if (e.declared === undefined || e.via !== 'explicit') continue;
            if (e.to !== e.declared) {
              drift.push(
                `${m.id}/${s.name}/${c.name}: '${e.event}' declared '${e.declared}' but routes '${e.to}'`,
              );
            }
          }
        }
      }
    }
    expect(drift).toEqual([]);
  });

  it('the pilot carries declarations for every explicitly-routed emission (migration ratchet)', () => {
    // Cart is on the ADR-0026 convention (the mono's other pilot, inventory/transfer, has no
    // demo counterpart): any event it emits that a state routes EXPLICITLY somewhere else must
    // have come from a block declaration. This pins the pilot's coverage so a new routed event
    // cannot ship declaration-less.
    const pilots = new Set(['CART_STATES']);
    const missing: string[] = [];
    for (const m of graph.machines) {
      if (!pilots.has(m.id)) continue;
      for (const s of m.states) {
        for (const c of s.commands ?? []) {
          for (const e of c.emits ?? []) {
            if (e.via === 'explicit' && e.declared === undefined) {
              missing.push(`${m.id}/${s.name}/${c.name}: '${e.event}' routed but undeclared`);
            }
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
