import next from "eslint-config-next";

const config = [
  ...next,
  { ignores: [".next*/**", "playwright-report/**", "test-results/**"] },
  {
    files: ["**/*.{ts,tsx}"],
    // Type-aware: needs a tsconfig, which the config files aren't in. components/ui is generated.
    ignores: ["**/*.config.ts", "components/ui/**"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Keeps `any` from spreading and catches checks that can never fail. Source only: tests poke at loose JSON.
    files: ["**/*.{ts,tsx}"],
    ignores: ["**/*.config.ts", "e2e/**", "**/*.test.ts", "components/ui/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "no-empty": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/only-throw-error": "error",
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    ignores: ["e2e/**", "components/ui/**"],
    rules: { "max-lines": ["error", { max: 600, skipBlankLines: true, skipComments: true }] },
  },
];

export default config;
