import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * GUARDRAIL for Tech Design §02 — the money lint.
 *
 * The PRD calls a wrong balance the most severe class of bug. The branded
 * Paise type stops most mistakes at the type level; these rules stop the ones
 * that slip through as plain numbers.
 */
/**
 * GUARDRAIL — syntax Node's type stripping cannot run.
 *
 * There is no build step: Node executes the TypeScript directly by erasing
 * types. Anything needing code generation therefore fails at startup — but
 * Vitest uses esbuild, which happily compiles it, so the tests stay green while
 * the deployed process refuses to boot. That gap cost a debugging session; these
 * rules and the smoke-boot gate close it from both sides.
 */
const stripOnlyRules = [
  {
    selector: "TSParameterProperty",
    message:
      "Constructor parameter properties need code generation and crash Node's type stripping. " +
      "Declare the field and assign it in the constructor body instead.",
  },
  {
    selector: "TSEnumDeclaration",
    message:
      "enum needs code generation and crashes Node's type stripping. Use a const array with " +
      "`as const` plus a derived union type — see ROLES in @sr/envelope/core.",
  },
  {
    selector: "TSModuleDeclaration[kind='namespace']",
    message: "namespace needs code generation and crashes Node's type stripping. Use modules.",
  },
  {
    selector: "Decorator",
    message: "Decorators need code generation and crash Node's type stripping.",
  },
];

const moneyRules = {
  "no-restricted-syntax": [
    "error",
    ...stripOnlyRules,
    {
      selector: "CallExpression[callee.name='parseFloat']",
      message: "parseFloat is banned: money is integer paise. Use rupeesToPaise() from @sr/envelope/core.",
    },
    {
      selector: "CallExpression[callee.object.name='Math'][callee.property.name='round']:has(Identifier[name=/[pP]aise|amount|balance|dues/])",
      message: "Rounding money means the arithmetic already went through a float. Use bigint paise throughout.",
    },
    {
      selector: "BinaryExpression[operator=/^[*/]$/] > Identifier[name=/_paise$|Paise$/]",
      message: "Multiply or divide money only inside the Money helpers, where the rounding rule is explicit.",
    },
    {
      selector: "TSTypeAnnotation > TSNumberKeyword[parent.parent.key.name=/[pP]aise$/]",
      message: "Paise must be bigint, never number — Number.MAX_SAFE_INTEGER is not a safe ceiling for money.",
    },
  ],
};

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", "**/*.config.js", "**/.dependency-cruiser.cjs"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      ...moneyRules,
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      eqeqeq: ["error", "always"],
      "no-console": ["warn", { allow: ["warn", "error", "log"] }],
    },
  },
  {
    // Tests may reach for the sharp tools they are testing — but NOT for syntax
    // the production runtime cannot execute. Test helpers get imported by app
    // code often enough that letting this slide would defeat the purpose.
    files: ["**/test/**/*.ts", "**/*.test.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...stripOnlyRules],
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
