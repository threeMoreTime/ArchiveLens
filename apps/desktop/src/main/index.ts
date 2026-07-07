import { app, BrowserWindow } from "electron";
import { createMainWindow } from "./windows/main";
import { sidecar, registerIpc } from "./ipc";
import { registerAssetProtocol, registerPrivilegedSchemes } from "./security/protocol";
import { logger } from "./logging/logger";

// 自定义协议必须在 app ready 之前声明为 privileged。
registerPrivilegedSchemes();

app.setAppUserModelId("io.archivelens.desktop");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const wins = BrowserWindow.getAllWindows();
    const main = wins[0];
    if (main) {
      if (main.isMinimized()) main.restore();
      main.focus();
    }
  });

  app.whenReady().then(async () => {
    registerAssetProtocol();
    registerIpc();

    // Sidecar 启动失败不阻塞 UI；诊断页会展示降级状态。
    try {
      await sidecar.start();
      logger.info("Sidecar 启动成功");
    } catch (err) {
      logger.error(`Sidecar 启动失败：${(err as Error).message}`);
    }

    await createMainWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  let quitting = false;
  app.on("before-quit", async (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    logger.info("应用退出，停止 Sidecar…");
    try {
      await sidecar.stop();
    } catch (err) {
      logger.warn(`Sidecar 停止异常：${(err as Error).message}`);
    }
    app.exit(0);
  });
}

// BrowserWindow 已在顶部导入。
