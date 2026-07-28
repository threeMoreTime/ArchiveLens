/**
 * P1-9：IPC schema 独立覆盖率配置。
 *
 * 用 @vitest/coverage-istanbul 采集 packages/ipc-schema/src/index.ts 的覆盖率，
 * 解决 v8 provider 无法采集外部 workspace 文件的限制。
 *
 * 运行现有 contract/baseline/resultParser/consistency/ast 测试（它们 import @shared/index
 * 并执行 ipc-schema 的全部导出），但 coverage 只统计 ipc-schema/src/index.ts（排除 generated/）。
 *
 * 用法：node node_modules/vitest/dist/cli.js run --config vitest.ipc-schema.config.ts --coverage
 */
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const repoRoot = resolve(__dirname, "../..");
const ipcSchemaDir = resolve(repoRoot, "packages/ipc-schema");

export default defineConfig({
  test: {
    environment: "node",
    // root 设为 ipc-schema 包目录，使 coverage 能追踪到本地 src/index.ts。
    // 测试文件用绝对路径 include（它们在 apps/desktop/tests 下）。
    root: ipcSchemaDir,
    include: [
      // 相对于 root（ipc-schema 包目录）的测试文件路径
      "../../apps/desktop/tests/contract.spec.ts",
      "../../apps/desktop/tests/ipcMethodBaseline.spec.ts",
      "../../apps/desktop/tests/ipcResultParser.spec.ts",
      "../../apps/desktop/tests/ipcContractConsistency.spec.ts",
      "../../apps/desktop/tests/ipcContractAst.spec.ts",
    ],
    globals: false,
    coverage: {
      provider: "istanbul",
      all: true,
      reportsDirectory: resolve(repoRoot, "coverage/ipc-schema"),
      reporter: ["text-summary", "json-summary"],
      include: [
        // 相对于 root（ipc-schema 包目录）
        "src/index.ts",
      ],
    },
  },
  resolve: {
    alias: {
      "@shared": resolve(ipcSchemaDir, "src"),
      "@renderer": resolve(__dirname, "src/renderer/src"),
    },
  },
});
