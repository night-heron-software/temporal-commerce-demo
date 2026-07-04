import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_"
      }]
    }
  },
  {
    // Temporal workflow and activity code must use the structured pino logger.
    // console.log bypasses structured logging and pollutes worker output.
    files: ["src/temporal/**/*.ts"],
    rules: {
      "no-console": "warn"
    }
  },
  {
    // Architecture invariant (ADR-0011, ported from nightheron-mono): workflow IDs are
    // built with buildWorkflowId()/buildWorkflowStartOptions(), never inline template
    // strings. The middle template element of `${storeId}.<domain>.${entityId}` is
    // exactly ".<domain>."; match that shape.
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "TemplateElement[value.raw=/\\.(cart|checkout|order|inventory|fulfillment|fulfiller-order|identity)\\./]",
          message:
            "Build workflow IDs with buildWorkflowId(storeId, domain, entityId) from " +
            "src/temporal/contracts/constants — never construct the {storeId}.{domain}.{entityId} " +
            "string inline. For workflow starts, prefer buildWorkflowStartOptions(...) so " +
            "correlation tags are applied too.",
        },
      ],
    },
  },
  {
    // Architecture invariants for domain state-machine code (ported from nightheron-mono):
    // no raw '__terminal:' strings (use terminal()/isTerminal()/deriveDisplayStatus from
    // the framework) and no raw definePureState authoring (use defineDomain()/transitions()
    // or the domain.state() escape hatch). The framework implements the encoding itself and
    // tests may assert on it, so both are exempt.
    files: ["src/temporal/**/*.ts"],
    ignores: ["src/temporal/framework/**", "**/*.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/^__terminal:/]",
          message:
            "Do not hardcode '__terminal:...' strings. Construct terminal targets with " +
            "terminal('reason') and test them with isTerminal(state, 'reason') from the framework.",
        },
        {
          selector:
            'ImportDeclaration:not([importKind="type"]) > ImportSpecifier[imported.name="definePureState"][local.name="definePureState"]',
          message:
            "Use defineDomain().transitions() (or the domain.state() escape hatch) from the " +
            "authoring layer instead of raw definePureState().",
        },
      ],
    },
  },
  {
    // Pure decider/states files must never read the wall clock or randomness — every phase
    // receives a deterministic timestamp (meta.timestamp in decide, the `at` argument in
    // onTransition hooks). `new Date(<arg>)` (parsing a deterministic value) is still allowed.
    files: [
      "src/temporal/**/states.ts",
      "src/temporal/**/supplier-states.ts",
      "src/temporal/**/*-decider.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: 'NewExpression[callee.name="Date"][arguments.length=0]',
          message:
            "Do not read the wall clock in a states/decider file. Use the deterministic " +
            "timestamp your phase already receives (meta.timestamp, or the `at` argument).",
        },
        {
          selector: 'CallExpression[callee.object.name="Date"][callee.property.name="now"]',
          message:
            "Do not read the wall clock in a states/decider file. Use the deterministic " +
            "timestamp your phase already receives (meta.timestamp, or the `at` argument).",
        },
        {
          selector: 'CallExpression[callee.object.name="Math"][callee.property.name="random"]',
          message:
            "No randomness in a states/decider file — generate ids in the shell prepare " +
            "(uuid4()) and inject them via the command.",
        },
      ],
    },
  }
]);

export default eslintConfig;
