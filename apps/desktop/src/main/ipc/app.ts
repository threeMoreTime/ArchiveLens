import { app, dialog, ipcMain, shell, BrowserWindow } from "electron";
import type { SidecarManager } from "../sidecar/manager";
import { AppInfoResultSchema, DiagnosticsResultSchema } from "@shared/index";
import { logger } from "../logging/logger";
import { loadDesktopBuildInfo } from "../buildInfo";

/**
 * 应用级 IPC handler（任务 §8.2 Preload API 对应）。
 *
 * Renderer 仅通过这些显式通道与 Main 交互，不接触 ipcRenderer / fs / child_process。
 */
export function registerAppHandlers(sidecar: SidecarManager): void {
  ipcMain.handle("app.getInfo", async () => {
    const info = AppInfoResultSchema.parse(await sidecar.call("app.info", {}));
    return AppInfoResultSchema.parse({
      ...info,
      app_version: app.getVersion(),
      desktop_metadata: loadDesktopBuildInfo(),
    });
  });

  ipcMain.handle("app.getEnvironment", async () => {
    let engine = null;
    try {
      const raw = await sidecar.call("diagnostics.run", {});
      engine = DiagnosticsResultSchema.parse(raw);
    } catch (err) {
      logger.warn(`getEnvironment 诊断失败：${(err as Error).message}`);
    }
    return {
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      sidecarReady: sidecar.isReady,
      engine,
    };
  });

  ipcMain.handle("dialog.selectFolder", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      title: "选择扫描目录",
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0]!;
  });

  ipcMain.handle("dialog.selectFile", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      title: "选择文件",
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0]!;
  });

  ipcMain.handle("app.openLogDirectory", async () => {
    await shell.openPath(logger.logDirectory);
  });
}
