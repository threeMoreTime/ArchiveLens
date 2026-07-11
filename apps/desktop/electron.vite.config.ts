import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

/**
 * electron-vite 构建：main / preload 编译为 CJS（Electron 主进程要求），
 * renderer 编译为 ESM（浏览器侧）。
 * main 与 preload 都启用 externalizeDepsPlugin，依赖不打进产物。
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/main",
      lib: { entry: "src/main/index.ts" },
    },
    resolve: {
      alias: {
        "@shared": resolve(__dirname, "../../packages/ipc-schema/src"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/preload",
      lib: { entry: "src/preload/index.ts" },
    },
  },
  renderer: {
    root: "src/renderer",
    build: {
      outDir: "out/renderer",
    },
    plugins: [react()],
    resolve: {
      alias: {
        "@renderer": resolve(__dirname, "src/renderer/src"),
        "@shared": resolve(__dirname, "../../packages/ipc-schema/src"),
      },
    },
  },
});
