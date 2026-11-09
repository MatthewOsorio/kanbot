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
    // Keeps `any` from spreading and catches checks that can never fail. Source only: tests poke at loose JSON.
    files: ["**/*.ts"],
    ignores: ["**/*.config.ts", "**/*.test.ts", "**/test/**"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unnecessary-condition": "error",
      "require-await": "off",
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/only-throw-error": "error",
    },
  },
  {
    files: ["**/*.ts"],
    ignores: ["**/*.test.ts", "**/test/**"],
    rules: { "max-lines": ["error", { max: 600, skipBlankLines: true, skipComments: true }] },
  },
);
