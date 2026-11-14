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
    // Privacy rule: only the privacy gate may import the remote adapter (paths finalised in Phase 2/3).
    files: ["packages/**/*.ts", "apps/**/*.ts"],
    ignores: ["packages/agent/src/gate/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/models/**/remote*", "**/remote-adapter*"],
              message: "Only the privacy gate (packages/agent/src/gate) may import the remote adapter.",
            },
          ],
        },
      ],
    },
  },
);
