import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "node_modules/**", "sample-data/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
  {
    // Privacy rule: only the privacy gate may import the remote adapter (and it lives in models/src/remote).
    files: ["packages/**/*.ts", "apps/**/*.ts", "scripts/**/*.ts"],
    ignores: ["packages/agent/src/gate/**", "packages/models/src/remote/**", "packages/models/src/models.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/remote/remote-adapter*", "**/remote-adapter*", "@lf/models/remote"],
              message: "Only the privacy gate (packages/agent/src/gate) may import the remote adapter.",
            },
          ],
        },
      ],
    },
  },
);
