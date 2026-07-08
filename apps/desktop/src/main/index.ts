import { app, BrowserWindow, dialog } from "electron";
import { resolve } from "node:path";
import { createMainWindow } from "./windows/main";
import { sidecar, registerIpc } from "./ipc";
import { createLifecycleController, type CloseAction } from "./lifecycle/controller";
import { registerAssetProtocol, registerPrivilegedSchemes } from "./security/protocol";
import { createTray, destroyTray } from "./tray";
import { logger } from "./logging/logger";

// 自定义协议必须在 app ready 之前声明为 privileged。
registerPrivilegedSchemes();

const userDataOverride = process.env["ARCHIVELENS_USER_DATA_DIR"];
if (userDataOverride) {
  app.setPath("userData", resolve(userDataOverride));
}

app.setAppUserModelId("io.archivelens.desktop");

interface TaskSummary {
  task_id: string;
  name?: string;
  source_dir?: string;
  status: string;
  processed_pages?: number;
  total_pages?: number;
}

const ACTIVE_STATUSES = ["starting", "running", "pausing", "stopping"];
const RECOVERABLE_STATUSES = ["paused", "recoverable", "stale", "running", "pausing", "starting"];
const lifecycle = createLifecycleController({
  sidecar,
  logger,
  getMainWindow: () => BrowserWindow.getAllWindows()[0] ?? null,
  destroyTray,
  appControl: { exit: (code) => app.exit(code), quit: () => app.quit() },
  timeoutMs: Number(process.env["ARCHIVELENS_E2E_SHUTDOWN_TIMEOUT_MS"] ?? 15_000),
  waitForTaskEvent: waitForEvent,
  findActiveTask,
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const main = BrowserWindow.getAllWindows()[0];
    if (main) {
      if (main.isMinimized()) main.restore();
      main.show();
      main.focus();
    }
  });

  app.whenReady().then(async () => {
    registerAssetProtocol();
    registerIpc(lifecycle);

    // Sidecar 启动失败不阻塞 UI；诊断页会展示降级状态。
    try {
      await sidecar.start();
      logger.info("Sidecar 启动成功");
    } catch (err) {
      logger.error(`Sidecar 启动失败：${(err as Error).message}`);
    }

    createTray(() => BrowserWindow.getAllWindows()[0] ?? null);
    await createMainWindow();

    // 重启恢复：查询未完成/可恢复任务并通知 Renderer（不自动恢复、不自动删除）
    void reportRecoverableTasks();
  });

  app.on("window-all-closed", () => {
    // 触发 before-quit 协调器（由其决定最小化/暂停/停止/退出）
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("before-quit", async (event) => {
    if (lifecycle.getState().approvedQuit) {
      return; // 已批准真正退出
    }
    event.preventDefault();
    try {
      const request = await lifecycle.requestClose();
      if (!request.requiresAction) {
        return;
      }

      const choice = await promptShutdown(request.activeTask ?? { task_id: "", status: "running" });
      await lifecycle.selectCloseAction(choice);
    } catch (err) {
      logger.error(`关闭流程异常：${(err as Error).message}`);
      lifecycle.reset();
    }
  });
}

async function findActiveTask(): Promise<TaskSummary | null> {
  if (!sidecar.isReady) {
    return null;
  }
  try {
    const res = await sidecar.call<{ items: TaskSummary[] }>("tasks.list", { limit: 50 });
    return (res.items || []).find((t) => ACTIVE_STATUSES.includes(t.status)) ?? null;
  } catch {
    return null;
  }
}

async function promptShutdown(task: TaskSummary): Promise<CloseAction> {
  const win = BrowserWindow.getAllWindows()[0];
  const res = await dialog.showMessageBox(win ?? new BrowserWindow({ show: false }), {
    type: "warning",
    title: "ArchiveLens",
    message: "当前仍有扫描任务正在运行",
    detail: `任务：${task.name || task.source_dir || task.task_id}`,
    buttons: ["最小化到托盘并继续", "暂停任务并退出", "停止任务并退出", "取消"],
    cancelId: 3,
    noLink: true,
  });
  const choices = ["minimize", "pause_and_quit", "stop_and_quit", "cancel"] as const;
  return choices[res.response] ?? "cancel";
}

function waitForEvent(eventName: string, taskId: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      sidecar.off("event", handler);
      resolve(false);
    }, timeoutMs);
    const handler = (e: { event?: string; task_id?: string }) => {
      if (e.event === eventName && e.task_id === taskId) {
        clearTimeout(timer);
        sidecar.off("event", handler);
        resolve(true);
      }
    };
    sidecar.on("event", handler);
  });
}

async function reportRecoverableTasks(): Promise<void> {
  if (!sidecar.isReady) {
    return;
  }
  try {
    const res = await sidecar.call<{ items: TaskSummary[] }>("tasks.list", { limit: 50 });
    const recoverable = (res.items || []).filter((t) => RECOVERABLE_STATUSES.includes(t.status));
    if (recoverable.length > 0) {
      logger.info(
        `发现 ${recoverable.length} 个未完成/可恢复任务：${recoverable.map((t) => t.task_id).join(",")}`,
      );
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.webContents.send("archiveLens:recoverable", recoverable);
      }
    }
  } catch {
    // 忽略：恢复查询失败不影响启动
  }
}
