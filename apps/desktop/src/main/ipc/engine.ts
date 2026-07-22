import { app, ipcMain, shell } from "electron";
import { z } from "zod";
import type { SidecarManager } from "../sidecar/manager";
import { registerResourceRoot, unregisterResourceRoot } from "../security/protocol";
import { getSettingsStore } from "./settings";
import { logger } from "../logging/logger";
import {
  OcrSearchExecuteParamsSchema,
  OcrSearchHitsParamsSchema,
  OcrSearchPreparePageImageParamsSchema,
  OcrSearchSessionsParamsSchema,
  ReviewLayoutContextParamsSchema,
  ReviewPreviewLayoutContextParamsSchema,
  ReviewRebuildLayoutContextsParamsSchema,
  ReviewUpdateLayoutOverrideParamsSchema,
  ReviewUpdateDecisionParamsSchema,
  ReviewUpdateDecisionsParamsSchema,
  SourcePreflightJobParamsSchema,
  SourcePreflightStartParamsSchema,
  TaskCreateParamsSchema,
} from "@shared/index";
import { resolveTaskDataDirectory, resolveTaskExportDirectory } from "../localData";

export const HTML_EXPORT_TIMEOUT_MS = 30 * 60_000;
export const TASK_CREATE_TIMEOUT_MS = 30 * 60_000;
const IpcParamsSchema = z.record(z.string(), z.unknown());

function parseIpcParams(params: unknown): Record<string, unknown> {
  return IpcParamsSchema.parse(params);
}

/**
 * 转发类 IPC：把 Renderer 请求经 Sidecar 投递到 Python Engine。
 *
 * 任务创建/演示创建后，把 task workspace 注册为 al-resource 协议的资源根，
 * Renderer 即可用 ``al-resource://<task_id>/<relpath>`` 加载出处页/字符图，
 * 且看不到绝对路径。
 */
export function registerEngineHandlers(sidecar: SidecarManager): void {
  ipcMain.handle("demo.create", async () => {
    const result = await sidecar.call<{ task_id: string; workspace_dir?: string }>("demo.create", {});
    if (result.workspace_dir) {
      registerResourceRoot(result.task_id, result.workspace_dir);
    }
    return result;
  });

  ipcMain.handle("tasks.create", async (_e, params: unknown) =>
    sidecar.call("tasks.create", TaskCreateParamsSchema.parse(params), TASK_CREATE_TIMEOUT_MS),
  );
  ipcMain.handle("tasks.preflight", async (_e, params: unknown) =>
    sidecar.call("tasks.preflight", SourcePreflightStartParamsSchema.parse(params)),
  );
  ipcMain.handle("tasks.preflightGet", async (_e, params: unknown) =>
    sidecar.call("tasks.preflightGet", SourcePreflightJobParamsSchema.parse(params)),
  );
  ipcMain.handle("tasks.preflightCancel", async (_e, params: unknown) =>
    sidecar.call("tasks.preflightCancel", SourcePreflightJobParamsSchema.parse(params)),
  );
  ipcMain.handle("tasks.start", async (_e, params: unknown) => {
    const r = await sidecar.call<{ workspace_dir?: string }>("tasks.start", parseIpcParams(params));
    // 扫描完成后 workspace_dir 由 engine 写入；此处也兼容查询时再注册。
    return r;
  });
  ipcMain.handle("tasks.get", async (_e, params: unknown) => {
    const r = await sidecar.call<{ task_id: string; workspace_dir?: string }>("tasks.get", parseIpcParams(params));
    if (r.workspace_dir) registerResourceRoot(r.task_id, r.workspace_dir);
    return r;
  });
  ipcMain.handle("tasks.list", async (_e, params: unknown) => sidecar.call("tasks.list", parseIpcParams(params)));
  ipcMain.handle("tasks.pause", async (_e, params: unknown) => sidecar.call("tasks.pause", parseIpcParams(params)));
  ipcMain.handle("tasks.resume", async (_e, params: unknown) => sidecar.call("tasks.resume", parseIpcParams(params)));
  ipcMain.handle("tasks.cancel", async (_e, params: unknown) => sidecar.call("tasks.cancel", parseIpcParams(params)));
  ipcMain.handle("tasks.delete", async (_e, params: { task_id: string }) => {
    const result = await sidecar.call<{ task_id: string; deleted: true }>("tasks.delete", params);
    unregisterResourceRoot(result.task_id);
    await getSettingsStore().removeTaskOverride(result.task_id).catch((error) => {
      logger.warn(`清理任务校对设置失败：${(error as Error).message}`);
    });
    return result;
  });
  ipcMain.handle("tasks.openCleanupDir", async (_e, params: { task_id: string }) => {
    // 受控打开残留目录：路径由 engine 从受信 workspace_root + task_id 推导并校验，
    // renderer 不接触绝对路径，也无法传入任意路径。
    const result = await sidecar.call<{ task_id: string; path: string | null }>("tasks.cleanupTarget", params);
    if (!result.path) throw new Error("任务没有可打开的残留目录");
    const failure = await shell.openPath(result.path);
    if (failure) throw new Error(`无法打开文件夹：${failure}`);
    return { ok: true };
  });
  ipcMain.handle("tasks.openDirectory", async (_e, params: { task_id: string }) => {
    const directory = await resolveTaskDataDirectory(app.getPath("userData"), params.task_id);
    const failure = await shell.openPath(directory);
    if (failure) throw new Error(`无法打开任务目录：${failure}`);
    return { ok: true };
  });

  ipcMain.handle("results.query", async (_e, params: unknown) => sidecar.call("results.query", parseIpcParams(params)));
  ipcMain.handle("results.getDetail", async (_e, params: unknown) => sidecar.call("results.getDetail", parseIpcParams(params)));
  ipcMain.handle("search.corpusStatus", async (_e, params: unknown) => {
    const parsed = OcrSearchSessionsParamsSchema.pick({ task_id: true }).parse(params);
    return sidecar.call("search.corpusStatus", parsed);
  });
  ipcMain.handle("search.execute", async (_e, params: unknown) =>
    sidecar.call("search.execute", OcrSearchExecuteParamsSchema.parse(params)),
  );
  ipcMain.handle("search.sessions", async (_e, params: unknown) =>
    sidecar.call("search.sessions", OcrSearchSessionsParamsSchema.parse(params)),
  );
  ipcMain.handle("search.hits", async (_e, params: unknown) =>
    sidecar.call("search.hits", OcrSearchHitsParamsSchema.parse(params)),
  );
  ipcMain.handle("search.preparePageImage", async (_e, params: unknown) =>
    sidecar.call("search.preparePageImage", OcrSearchPreparePageImageParamsSchema.parse(params)),
  );

  ipcMain.handle("review.preparePageImage", async (_e, params: unknown) =>
    sidecar.call("review.preparePageImage", parseIpcParams(params)),
  );
  ipcMain.handle("review.layoutContext", async (_e, params: unknown) =>
    sidecar.call("review.layoutContext", ReviewLayoutContextParamsSchema.parse(params)),
  );
  ipcMain.handle("review.previewLayoutContext", async (_e, params: unknown) =>
    sidecar.call("review.previewLayoutContext", ReviewPreviewLayoutContextParamsSchema.parse(params)),
  );
  ipcMain.handle("review.updateLayoutOverride", async (_e, params: unknown) =>
    sidecar.call("review.updateLayoutOverride", ReviewUpdateLayoutOverrideParamsSchema.parse(params)),
  );
  ipcMain.handle("review.rebuildLayoutContexts", async (_e, params: unknown) =>
    sidecar.call("review.rebuildLayoutContexts", ReviewRebuildLayoutContextsParamsSchema.parse(params)),
  );
  ipcMain.handle("review.updateDecision", async (_e, params: unknown) =>
    sidecar.call("review.updateDecision", ReviewUpdateDecisionParamsSchema.parse(params)),
  );
  ipcMain.handle("review.updateDecisions", async (_e, params: unknown) =>
    sidecar.call("review.updateDecisions", ReviewUpdateDecisionsParamsSchema.parse(params)),
  );
  ipcMain.handle("review.updateNote", async (_e, params: unknown) => sidecar.call("review.updateNote", parseIpcParams(params)));

  ipcMain.handle("export.json", async (_e, params: unknown) => sidecar.call("export.json", parseIpcParams(params)));
  ipcMain.handle("export.review", async (_e, params: unknown) => sidecar.call("export.review", parseIpcParams(params)));
  ipcMain.handle("export.html", async (_e, params: unknown) =>
    sidecar.call("export.html", parseIpcParams(params), HTML_EXPORT_TIMEOUT_MS),
  );
  ipcMain.handle("exports.list", async (_e, params: unknown) => sidecar.call("exports.list", parseIpcParams(params)));
  ipcMain.handle("exports.create", async (_e, params: unknown) => sidecar.call("exports.create", parseIpcParams(params)));
  ipcMain.handle("exports.get", async (_e, params: unknown) => sidecar.call("exports.get", parseIpcParams(params)));
  ipcMain.handle("exports.listJobs", async (_e, params: unknown) => sidecar.call("exports.listJobs", parseIpcParams(params)));
  ipcMain.handle("exports.cancel", async (_e, params: unknown) => sidecar.call("exports.cancel", parseIpcParams(params)));
  ipcMain.handle("exports.retry", async (_e, params: unknown) => sidecar.call("exports.retry", parseIpcParams(params)));
  ipcMain.handle("exports.openDirectory", async (_e, params: { export_id: string }) => {
    const job = await sidecar.call<{ task_id: string }>("exports.get", params);
    const directory = await resolveTaskExportDirectory(app.getPath("userData"), job.task_id);
    const failure = await shell.openPath(directory);
    if (failure) throw new Error(`无法打开导出目录：${failure}`);
    return { ok: true };
  });
}
