import eslint from "@eslint/js";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

const sourceFiles = [
  "apps/desktop/src/**/*.{ts,tsx}",
  "packages/ipc-schema/src/**/*.ts",
];
const testFiles = [
  "apps/desktop/tests/**/*.ts",
  "apps/desktop/e2e/**/*.ts",
];
const allTypeScriptFiles = [...sourceFiles, ...testFiles];

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/out/**",
      "**/dist/**",
      "**/release/**",
      "**/coverage/**",
      "**/test-results/**",
      "**/playwright-report/**",
    ],
  },
  { ...eslint.configs.recommended, files: allTypeScriptFiles },
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: testFiles })),
  {
    files: testFiles,
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: sourceFiles,
    languageOptions: {
      ...config.languageOptions,
      parserOptions: {
        ...config.languageOptions?.parserOptions,
        project: [
          "./apps/desktop/tsconfig.node.json",
          "./apps/desktop/tsconfig.web.json",
          "./packages/ipc-schema/tsconfig.json",
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  })),
  {
    files: sourceFiles,
    rules: {
      "no-empty": ["error", { allowEmptyCatch: false }],
      "no-duplicate-imports": "error",
      "no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { attributes: false } }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["apps/desktop/src/renderer/src/**/*.{ts,tsx}"],
    plugins: { react, "react-hooks": reactHooks },
    settings: { react: { version: "detect" } },
    rules: {
      "react/jsx-key": "error",
      "react/jsx-no-duplicate-props": "error",
      "react/no-unknown-property": "error",
      "react/no-unescaped-entities": "error",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*", "electron", "fs", "fs/*", "path", "path/*", "child_process", "os", "process"],
              message: "Renderer 不得导入 Node/Electron API；请通过类型明确的 Preload IPC 暴露能力。",
            },
          ],
        },
      ],
    },
  },
);
