import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.spec.ts"],
    globals: false,
    coverage: {
      provider: "v8",
      all: true,
      reportsDirectory: "../../coverage/desktop",
      reporter: ["text-summary", "json-summary", "json"],
      include: [
        "src/main/**/*.ts",
        "src/preload/**/*.ts",
        "src/renderer/src/**/*.{ts,tsx}",
      ],
    },
  },
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "../../packages/ipc-schema/src"),
    },
  },
});
