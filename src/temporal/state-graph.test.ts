/**
 * Assertions over the generated state graph (docs/reference/state-graph.json).
 *
 * The graph is produced by `npm run docs:diagrams` via static AST analysis of the
 * domain states files; CI regenerates and `--check`s it, so these tests run against a
 * guaranteed-fresh snapshot. They make structural properties of every machine —
 * "the expected machines exist", "no orphan states", "every waiting state can move" —
 * queryable instead of eyeballed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

interface GraphTransition {
  on: string;
  kind: string;
  to: string;
}
interface GraphState {
  name: string;
  transitional?: boolean;
  transitions: GraphTransition[];
}
interface GraphMachine {
  domain: string;
  registry: string;
  initialState: string;
  states: GraphState[];
}

const GRAPH_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../docs/reference/state-graph.json',
);

const graph = JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf-8')) as { machines: GraphMachine[] };

const EXPECTED_REGISTRIES = [
  'CART_STATES',
  'CHECKOUT_STATES',
  'OMS_STATES',
  'FULFILLMENT_STATES',
  'FULFILLER_ORDER_STATES',
];

describe('state-graph.json', () => {
  it('contains every expected domain machine', () => {
    const registries = graph.machines.map((m) => m.registry).sort();
    expect(registries).toEqual([...EXPECTED_REGISTRIES].sort());
  });

  it.each(graph.machines.map((m) => [m.registry, m] as const))(
    '%s: initialState is a real state',
    (_registry, machine) => {
      expect(machine.states.map((s) => s.name)).toContain(machine.initialState);
    },
  );

  it.each(graph.machines.map((m) => [m.registry, m] as const))(
    '%s: every non-transitional state has an outgoing transition',
    (_registry, machine) => {
      for (const state of machine.states) {
        if (state.transitional) continue;
        expect(
          state.transitions.length,
          `state '${state.name}' has no outgoing edges`,
        ).toBeGreaterThan(0);
      }
    },
  );

  it.each(graph.machines.map((m) => [m.registry, m] as const))(
    '%s: every state is reachable from the initial state',
    (_registry, machine) => {
      const reachable = new Set<string>([machine.initialState]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const state of machine.states) {
          if (!reachable.has(state.name)) continue;
          for (const t of state.transitions) {
            if (!t.to.startsWith('__terminal:') && !reachable.has(t.to)) {
              reachable.add(t.to);
              grew = true;
            }
          }
        }
      }
      const orphans = machine.states.map((s) => s.name).filter((n) => !reachable.has(n));
      expect(orphans, `unreachable states: ${orphans.join(', ')}`).toEqual([]);
    },
  );
});
