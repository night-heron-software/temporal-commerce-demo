import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
  ]),
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // Temporal workflow and activity code must use the structured pino logger.
    // console.log bypasses structured logging and pollutes worker output.
    files: ['src/temporal/**/*.ts'],
    rules: {
      'no-console': 'warn',
    },
  },
  {
    // Architecture invariant #1 (ported from nightheron-mono): no cross-domain workflow
    // imports. Orchestration uses string-based startChild / getExternalWorkflowHandle with
    // contracts constants, so a workflow module is only ever imported by its OWN domain
    // ('./workflows' — not matched here) and its worker. Tests are exempt: they drive real
    // cross-domain journeys and import workflow functions to start them typed.
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../*/workflows', '@/temporal/*/workflows'],
              message:
                "Do not import another domain's workflow functions. Cross-domain orchestration " +
                'uses string-based startChild/getExternalWorkflowHandle with constants from ' +
                'src/temporal/contracts (invariant #1).',
            },
          ],
        },
      ],
    },
  },
  {
    // Architecture invariant (ADR-0011, ported from nightheron-mono): workflow IDs are
    // built with buildWorkflowId()/buildWorkflowStartOptions(), never inline template
    // strings. The middle template element of `${storeId}.<domain>.${entityId}` is
    // exactly ".<domain>."; match that shape.
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'TemplateElement[value.raw=/\\.(cart|checkout|order|inventory|fulfillment|fulfiller-order|identity)\\./]',
          message:
            'Build workflow IDs with buildWorkflowId(storeId, domain, entityId) from ' +
            'src/temporal/contracts/constants — never construct the {storeId}.{domain}.{entityId} ' +
            'string inline. For workflow starts, prefer buildWorkflowStartOptions(...) so ' +
            'correlation tags are applied too.',
        },
      ],
    },
  },
  {
    // Architecture invariants for domain state-machine code (ported from nightheron-mono):
    // no raw '__terminal:' strings (use terminal()/isTerminal()/deriveDisplayStatus from
    // the framework), and the retired first-generation authoring surface (defineDomain /
    // defineTransitions / definePureState / route and their types) must not return —
    // defineMachine is the only authoring surface (ADR-0024, mono clarity plan Phase 4).
    // The framework implements the terminal encoding itself and tests may assert on it,
    // so both are exempt from the terminal-literal ban.
    files: ['src/temporal/**/*.ts'],
    ignores: ['src/temporal/framework/**', '**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/^__terminal:/]',
          message:
            "Do not hardcode '__terminal:...' strings. Construct terminal targets with " +
            "terminal('reason') and test them with isTerminal(state, 'reason') from the framework.",
        },
        // The names were DELETED from the vendored framework in the 2026-08-09 sync
        // (mono clarity-plan Phase 4); this ban keeps them from being re-invented.
        // Matched on imports whose source ends in 'framework' (the vendored copy's
        // relative import path) — 'route' and 'Decider' are generic enough to be
        // legitimate names elsewhere. Type imports are banned too: the types are gone.
        ...[
          'defineDomain',
          'defineTransitions',
          'definePureState',
          'route',
          'PureStateHandler',
          'DecisionResult',
          'TransitionHandler',
          'SignalHandler',
          'SignalMap',
          'InputHandlers',
          'TransitionMap',
          'RouteTable',
          'Decider',
        ].map((name) => ({
          selector: `ImportDeclaration[source.value=/framework$/] ImportSpecifier[imported.name="${name}"]`,
          message:
            `'${name}' is the retired first-generation authoring surface, deleted in the mono's ` +
            'clarity-plan Phase 4 (ADR-0024). Author machines with defineMachine: a pure ' +
            'MachineDecider (decide/evolve) plus per-state commands / route / effects declarations.',
        })),
      ],
    },
  },
  {
    // Pure decider/states files must never read the wall clock or randomness — every phase
    // receives a deterministic timestamp (meta.timestamp in decide, the `at` argument in
    // onTransition hooks). `new Date(<arg>)` (parsing a deterministic value) is still allowed.
    files: [
      'src/temporal/**/states.ts',
      'src/temporal/**/supplier-states.ts',
      'src/temporal/**/*-decider.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'NewExpression[callee.name="Date"][arguments.length=0]',
          message:
            'Do not read the wall clock in a states/decider file. Use the deterministic ' +
            'timestamp your phase already receives (meta.timestamp, or the `at` argument).',
        },
        {
          selector: 'CallExpression[callee.object.name="Date"][callee.property.name="now"]',
          message:
            'Do not read the wall clock in a states/decider file. Use the deterministic ' +
            'timestamp your phase already receives (meta.timestamp, or the `at` argument).',
        },
        {
          selector: 'CallExpression[callee.object.name="Math"][callee.property.name="random"]',
          message:
            'No randomness in a states/decider file — generate ids in the shell prepare ' +
            '(uuid4()) and inject them via the command.',
        },
      ],
    },
  },
  {
    // Ported from the mono's invariants: clock reads banned inside anything literally named
    // decide/evolve, wherever it lives — the per-file scoping above misses a decider defined
    // outside a states/*-decider file. I/O phases (prepare/finalize/onTransition) may read
    // the clock, which is why this keys on the function/property NAME.
    files: ['src/temporal/**/*.ts'],
    ignores: ['src/temporal/framework/**', '**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Property[key.name=/^(decide|evolve)$/] NewExpression[callee.name="Date"]',
          message:
            'Do not read the clock inside a pure decide/evolve. Stamp records from the deterministic ' +
            'meta.timestamp so the decision stays pure and replayable. Clock reads belong in ' +
            'prepare/finalize or onTransition hooks.',
        },
        {
          selector:
            'Property[key.name=/^(decide|evolve)$/] CallExpression[callee.object.name="Date"][callee.property.name="now"]',
          message:
            'Do not read the clock inside a pure decide/evolve. Stamp records from the deterministic ' +
            'meta.timestamp so the decision stays pure and replayable. Clock reads belong in ' +
            'prepare/finalize or onTransition hooks.',
        },
        {
          selector:
            'FunctionDeclaration[id.name=/^(decide|evolve)$/] NewExpression[callee.name="Date"]',
          message:
            'Do not read the clock inside a pure decide/evolve. Stamp records from the deterministic ' +
            'meta.timestamp so the decision stays pure and replayable. Clock reads belong in ' +
            'prepare/finalize or onTransition hooks.',
        },
        {
          selector:
            'FunctionDeclaration[id.name=/^(decide|evolve)$/] CallExpression[callee.object.name="Date"][callee.property.name="now"]',
          message:
            'Do not read the clock inside a pure decide/evolve. Stamp records from the deterministic ' +
            'meta.timestamp so the decision stays pure and replayable. Clock reads belong in ' +
            'prepare/finalize or onTransition hooks.',
        },
      ],
    },
  },
  {
    // CommonJS scripts (e.g. scripts/standalone-activity-smoke.cjs) are .cjs on
    // purpose — they run under plain `node` with no TS/ESM toolchain. require()
    // is their module system, not a style violation.
    files: ['**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
]);

export default eslintConfig;
