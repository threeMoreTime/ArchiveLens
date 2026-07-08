import { BrowserWindow } from "electron";
import { SidecarManager } from "../sidecar/manager";
import { registerAppHandlers } from "./app";
import { registerE2eHandlers } from "./e2e";
import { registerEngineHandlers } from "./engine";
import { logger } from "../logging/logger";
import type { LifecycleController } from "../lifecycle/controller";

/** 全局 Sidecar 单例。 */
export const sidecar = new SidecarManager();

let registered = false;

/** 注册全部 ipcMain handler（幂等）。 */
export function registerIpc(lifecycle?: LifecycleController): void {
  if (registered) return;
  registered = true;
  registerAppHandlers(sidecar);
  registerEngineHandlers(sidecar);
  if (lifecycle) {
    registerE2eHandlers(sidecar, lifecycle);
  }

  // 把 Sidecar 事件 / 异常退出广播给所有渲染窗口。
  sidecar.on("event", (event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send("archiveLens:event", event);
      }
    }
  });
  sidecar.on("exit", (info) => {
    if (!info.expected) {
      logger.error(`Sidecar 非预期退出，广播给 Renderer：code=${info.code} kind=${info.kind}`);
    }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !info.expected) {
        win.webContents.send("archiveLens:engineExit", info);
      }
    }
  });
}
