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
      // 注：packages/ipc-schema/src/index.ts 是外部 workspace 生产代码，应纳入覆盖率。
      // 但 Vitest 2.0.5 + v8 provider 在当前工具链下无法可靠采集外部 workspace 文件
      // （allowExternal 破坏原有 include 采集，相对/绝对路径 include 均不生效）。
      // 该文件的测试覆盖由 contract/baseline/resultParser/consistency 四组测试提供行为证据，
      // 覆盖率盲区在 PR 描述中如实记录。安装 @vitest/coverage-istanbul 后可解决此限制。
    },
  },
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "../../packages/ipc-schema/src"),
      "@renderer": resolve(__dirname, "src/renderer/src"),
    },
  },
});
