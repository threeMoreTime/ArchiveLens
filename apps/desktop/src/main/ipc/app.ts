import { app, dialog, ipcMain, shell } from "electron";
import { mkdir } from "node:fs/promises";
import type { SidecarManager } from "../sidecar/manager";
import {
  AppInfoResultSchema,
  DiagnosticsResultSchema,
  StorageCleanupResultSchema,
  SUPPORTED_SOURCE_EXTENSIONS,
} from "@shared/index";
import { logger } from "../logging/logger";
import { loadDesktopBuildInfo } from "../buildInfo";
import { collectLocalDataSummary } from "../localData";

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
    const startupError = sidecar.startupErrorSnapshot;
    return {
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      sidecarReady: sidecar.isReady,
      startupError: startupError
        ? { code: startupError.code, message: startupError.message, details: startupError.details }
        : null,
      engine,
    };
  });

  ipcMain.handle("dialog.selectFolder", async () => {
    const e2eFolder = process.env["ARCHIVELENS_E2E"] === "1"
      ? process.env["ARCHIVELENS_E2E_SELECT_FOLDER"]
      : undefined;
    if (e2eFolder) return e2eFolder;
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

  ipcMain.handle("dialog.selectFiles", async (_event, params: { multiple?: boolean } = {}) => {
    const multiple = params.multiple === true;
    const e2eFiles = process.env["ARCHIVELENS_E2E"] === "1"
      ? process.env["ARCHIVELENS_E2E_SELECT_FILES"]
      : undefined;
    if (e2eFiles) {
      try {
        const values: unknown = JSON.parse(e2eFiles);
        if (Array.isArray(values) && values.every((value) => typeof value === "string")) {
          return multiple ? values : values.slice(0, 1);
        }
      } catch {
        logger.warn("ARCHIVELENS_E2E_SELECT_FILES 必须是 JSON 字符串数组");
      }
    }
    const result = await dialog.showOpenDialog({
      properties: multiple ? ["openFile", "multiSelections"] : ["openFile"],
      title: "选择要扫描的文件",
      filters: [{ name: "支持的档案文件", extensions: [...SUPPORTED_SOURCE_EXTENSIONS] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return multiple ? result.filePaths : result.filePaths.slice(0, 1);
  });

  ipcMain.handle("app.openLogDirectory", async () => {
    const failure = await shell.openPath(logger.logDirectory);
    if (failure) throw new Error(`无法打开日志目录：${failure}`);
  });

  ipcMain.handle("app.getLocalDataSummary", async () =>
    collectLocalDataSummary(app.getPath("userData")),
  );

  ipcMain.handle("app.openUserDataDirectory", async () => {
    const userDataPath = app.getPath("userData");
    await mkdir(userDataPath, { recursive: true });
    const failure = await shell.openPath(userDataPath);
    if (failure) throw new Error(`无法打开本地数据目录：${failure}`);
  });

  ipcMain.handle("app.cleanupTemporaryData", async () =>
    StorageCleanupResultSchema.parse(await sidecar.call("storage.cleanupTemporary", {})),
  );
}
