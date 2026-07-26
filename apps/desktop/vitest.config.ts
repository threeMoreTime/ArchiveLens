import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    // .spec.ts 跑在 node 环境（源码契约测试）；.spec.tsx 跑在 jsdom（组件渲染测试），
    // 后者通过文件顶部的 @vitest-environment jsdom 注释单独指定环境。
    include: ["tests/**/*.spec.ts", "tests/**/*.spec.tsx"],
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
      "@renderer": resolve(__dirname, "src/renderer/src"),
    },
  },
});
