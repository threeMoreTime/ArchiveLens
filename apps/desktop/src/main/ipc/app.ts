import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import { mkdir } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import type { SidecarManager } from "../sidecar/manager";
import {
  AppInfoResultSchema,
  DiagnosticsResultSchema,
  AiDebugCopyParamsSchema,
  ClipboardCopyResultSchema,
  DeveloperSnapshotParamsSchema,
  DiagnosticCopyParamsSchema,
  RendererErrorReportSchema,
  StorageCleanupResultSchema,
  SUPPORTED_SOURCE_EXTENSIONS,
  type ClipboardCopyResult,
} from "@shared/index";
import { logger } from "../logging/logger";
import { loadDesktopBuildInfo } from "../buildInfo";
import { collectLocalDataSummary } from "../localData";
import { errorRegistry } from "../diagnostics/errorRegistry";
import {
  assertDeveloperModeEnabled,
  buildAiDebugReport,
  buildFullPathSummary,
  buildRedactedSummary,
  collectDeveloperSnapshot,
  readLogTail,
  type AiDebugOcrContext,
  type DeveloperDiagnosticsDeps,
  type DeveloperRuntimeInfo,
} from "../diagnostics/developerDiagnostics";
import { getSettingsStore } from "./settings";

/** 组装开发者快照所需的运行时信息（来自 Electron app/process/os）。 */
function buildRuntimeInfo(): DeveloperRuntimeInfo {
  const userDataPath = app.getPath("userData");
  let userName = "";
  try {
    userName = userInfo().username;
  } catch {
    userName = "";
  }
  return {
    app_version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    user_data_path: userDataPath,
    engine_data_path: `${userDataPath}/engine`,
    log_path: logger.logDirectory,
    user_name: userName,
    home_dir: homedir(),
  };
}

function developerDeps(sidecar: SidecarManager): DeveloperDiagnosticsDeps {
  return {
    runtime: buildRuntimeInfo(),
    sidecar,
    collectLocalData: (userDataPath: string) => collectLocalDataSummary(userDataPath),
    loadDesktopBuildInfo,
    snapshotForTask: (taskId: string) => errorRegistry.snapshotForTask(taskId),
    lastKnownError: () => errorRegistry.snapshot(),
  };
}

/** 门禁：完整复制、AI 调试、完整快照、日志与 DevTools 必须已开启开发者模式。 */
async function requireDeveloperMode(): Promise<void> {
  const { enabled } = await getSettingsStore().getDeveloperMode();
  assertDeveloperModeEnabled(enabled);
}

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
    await requireDeveloperMode();
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

  ipcMain.handle("app.getVersion", () => app.getVersion());

  // Renderer 上报最近一次错误：任何页面都可上报自身错误，Main 侧强制长度上限。
  ipcMain.handle("app.reportRendererError", (_event, params: unknown) => {
    const report = RendererErrorReportSchema.parse(params);
    errorRegistry.recordRendererReport(report);
    return { ok: true };
  });

  // 完整快照：受开发者模式门禁保护。
  ipcMain.handle("app.getDeveloperSnapshot", async (_event, params: unknown) => {
    await requireDeveloperMode();
    const parsed = DeveloperSnapshotParamsSchema.parse(params ?? {});
    return collectDeveloperSnapshot(developerDeps(sidecar), parsed);
  });

  // 复制诊断摘要：redacted 普通可用；full 必须已开启开发者模式。
  ipcMain.handle("app.copyDiagnosticSummary", async (_event, params: unknown): Promise<ClipboardCopyResult> => {
    const parsed = DiagnosticCopyParamsSchema.parse(params);
    if (parsed.mode === "full") await requireDeveloperMode();
    const snapshot = await collectDeveloperSnapshot(developerDeps(sidecar), { task_id: parsed.task_id });
    const text = parsed.mode === "full"
      ? buildFullPathSummary(snapshot, parsed.current_error)
      : buildRedactedSummary(snapshot, parsed.current_error);
    clipboard.writeText(text);
    return ClipboardCopyResultSchema.parse({
      mode: parsed.mode,
      char_count: text.length,
      log_line_count: 0,
      includes_ocr_context: false,
      ocr_context_status: "not_available",
    });
  });

  // 复制 AI 错误调试信息：必须已开启开发者模式；读取日志尾部与当前 OCR 上下文。
  ipcMain.handle("app.copyAiDebugInfo", async (_event, params: unknown): Promise<ClipboardCopyResult> => {
    await requireDeveloperMode();
    const parsed = AiDebugCopyParamsSchema.parse(params);
    const snapshot = await collectDeveloperSnapshot(developerDeps(sidecar), { task_id: parsed.task_id });
    const ocrContext = await collectAiDebugOcrContext(sidecar, parsed.task_id, parsed.occurrence_id);
    const { lines, errors } = await readLogTail(logger.logDirectory);
    const text = buildAiDebugReport(snapshot, ocrContext, lines, errors);
    clipboard.writeText(text);
    return ClipboardCopyResultSchema.parse({
      mode: "ai_debug",
      char_count: text.length,
      log_line_count: lines.length,
      includes_ocr_context: ocrContext.status === "included",
      ocr_context_status: ocrContext.status,
    });
  });

  // 在当前 Renderer 窗口打开 DevTools：必须已开启开发者模式。
  ipcMain.handle("app.openRendererDevTools", async (event) => {
    await requireDeveloperMode();
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) throw new Error("找不到当前窗口");
    win.webContents.openDevTools({ mode: "detach", activate: true, title: "ArchiveLens 开发者工具" });
    return { ok: true };
  });
}

/** 通过当前 task/occurrence 再次向 Engine 取证 OCR 上下文；无可用选择时返回 not_available。 */
async function collectAiDebugOcrContext(
  sidecar: SidecarManager,
  taskId: string | undefined,
  occurrenceId: string | undefined,
): Promise<AiDebugOcrContext> {
  if (!taskId || !occurrenceId) {
    return { status: "not_available", error: "未提供当前任务或选中结果" };
  }
  try {
    const occurrence = await sidecar.call<Record<string, unknown>>("results.getDetail", {
      task_id: taskId,
      occurrence_id: occurrenceId,
    });
    let layoutContext: unknown = null;
    try {
      const layout = await sidecar.call<{ context?: unknown }>("review.layoutContext", {
        task_id: taskId,
        occurrence_id: occurrenceId,
      });
      layoutContext = layout?.context ?? null;
    } catch (error) {
      layoutContext = { error: error instanceof Error ? error.message : String(error) };
    }
    return { status: "included", occurrence, layout_context: layoutContext };
  } catch (error) {
    return { status: "not_available", error: error instanceof Error ? error.message : String(error) };
  }
}
