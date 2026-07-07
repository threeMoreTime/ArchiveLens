import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.spec.ts"],
    globals: false,
  },
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "../../packages/ipc-schema/src"),
    },
  },
});
