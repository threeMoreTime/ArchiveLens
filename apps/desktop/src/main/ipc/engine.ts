import { ipcMain, shell } from "electron";
import type { SidecarManager } from "../sidecar/manager";
import { registerResourceRoot, unregisterResourceRoot } from "../security/protocol";

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

  ipcMain.handle("tasks.create", async (_e, params) => sidecar.call("tasks.create", params));
  ipcMain.handle("tasks.start", async (_e, params) => {
    const r = await sidecar.call<{ workspace_dir?: string }>("tasks.start", params);
    // 扫描完成后 workspace_dir 由 engine 写入；此处也兼容查询时再注册。
    return r;
  });
  ipcMain.handle("tasks.get", async (_e, params) => {
    const r = await sidecar.call<{ task_id: string; workspace_dir?: string }>("tasks.get", params);
    if (r.workspace_dir) registerResourceRoot(r.task_id, r.workspace_dir);
    return r;
  });
  ipcMain.handle("tasks.list", async (_e, params) => sidecar.call("tasks.list", params));
  ipcMain.handle("tasks.pause", async (_e, params) => sidecar.call("tasks.pause", params));
  ipcMain.handle("tasks.resume", async (_e, params) => sidecar.call("tasks.resume", params));
  ipcMain.handle("tasks.cancel", async (_e, params) => sidecar.call("tasks.cancel", params));
  ipcMain.handle("tasks.delete", async (_e, params: { task_id: string }) => {
    const result = await sidecar.call<{ task_id: string; deleted: true }>("tasks.delete", params);
    unregisterResourceRoot(result.task_id);
    return result;
  });

  ipcMain.handle("results.query", async (_e, params) => sidecar.call("results.query", params));
  ipcMain.handle("results.getDetail", async (_e, params) => sidecar.call("results.getDetail", params));

  ipcMain.handle("review.updateDecision", async (_e, params) =>
    sidecar.call("review.updateDecision", params),
  );
  ipcMain.handle("review.updateNote", async (_e, params) => sidecar.call("review.updateNote", params));

  ipcMain.handle("export.json", async (_e, params) => sidecar.call("export.json", params));
  ipcMain.handle("export.review", async (_e, params) => sidecar.call("export.review", params));
  ipcMain.handle("export.html", async (_e, params) => sidecar.call("export.html", params));
  ipcMain.handle("exports.list", async (_e, params) => sidecar.call("exports.list", params));

  ipcMain.handle("files.openFolder", async (_e, params: { path: string }) => {
    const failure = await shell.openPath(params.path);
    if (failure) throw new Error(`无法打开文件夹：${failure}`);
    return { ok: true };
  });
  ipcMain.handle("files.openOriginal", async (_e, params: { path: string }) => {
    const failure = await shell.openPath(params.path);
    if (failure) throw new Error(`无法打开文件：${failure}`);
    return { ok: true };
  });
}
