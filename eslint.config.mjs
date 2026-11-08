// Used by packages/shared and apps/worker (eslint walks up to here); apps/web has its own Next config.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "apps/web/**", "packages/shared/drizzle/**", "**/coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Type-aware: needs a tsconfig, which the config files aren't in.
    files: ["**/*.ts"],
    ignores: ["**/*.config.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },
  {
    files: ["**/*.ts"],
    ignores: ["**/*.test.ts", "**/test/**"],
    rules: { "max-lines": ["error", { max: 600, skipBlankLines: true, skipComments: true }] },
  },
);
