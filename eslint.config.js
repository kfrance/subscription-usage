import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

const vitestTestApiNames = "describe|it|suite|test";
const skippedTestPropertyNames = "skip|skipIf|todo";
const skippedOrFocusedTestPropertyNames = `${skippedTestPropertyNames}|only`;

// Mirrors the LearnWhale and my-claw testing policy: a committed test is either
// implemented or deleted. Skipping hides missing setup instead of reporting it.
const skippedTestRestrictedSyntax = [
  {
    selector: [
      `MemberExpression[property.name=/^(${skippedOrFocusedTestPropertyNames})$/][object.name=/^(${vitestTestApiNames})$/]`,
      `MemberExpression[property.name=/^(${skippedOrFocusedTestPropertyNames})$/][object.object.name=/^(${vitestTestApiNames})$/]`,
    ].join(", "),
    message:
      "Do not commit skipped, todo, or focused tests (.skip, .skipIf, .todo, .only). Implement the test or delete it.",
  },
  {
    selector: "CallExpression[callee.name=/^(fdescribe|fit|xdescribe|xit)$/]",
    message:
      "Do not commit skipped or focused test aliases. Use describe, it, or test.",
  },
];

export default tseslint.config(
  { ignores: ["node_modules/**", ".vite-temp/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
    },
    rules: {
      "no-restricted-syntax": ["error", ...skippedTestRestrictedSyntax],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": "error",
    },
  },
  {
    files: ["tests/**/*.ts"],
    languageOptions: { globals: { ...globals.node, ...globals.vitest } },
  },
);
