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
  }
]);

export default eslintConfig;
