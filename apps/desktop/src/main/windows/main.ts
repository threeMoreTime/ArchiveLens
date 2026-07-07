import { BrowserWindow, shell } from "electron";
import { join } from "node:path";
import { logger } from "../logging/logger";

const DEV_SERVER_URL = process.env["ELECTRON_RENDERER_URL"] ?? "";

/**
 * 创建主窗口。
 *
 * 安全默认（任务 §七）：
 * * ``nodeIntegration: false``、``contextIsolation: true``、``sandbox: true``、``webSecurity: true``；
 * * 禁止任意新窗口——https 外链转系统浏览器，其余一律 deny；
 * * 禁止导航到非本地 URL；
 * * 生产禁止 DevTools（除非 ``AL_DEBUG=1``）。
 */
export async function createMainWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#f4efe7",
    title: "ArchiveLens",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });

  win.once("ready-to-show", () => win.show());

  // 禁止任意新窗口；https 外链交给系统浏览器。
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (new URL(url).protocol === "https:") {
        shell.openExternal(url);
      }
    } catch {
      // 非法 URL 直接拒绝。
    }
    return { action: "deny" };
  });

  // 拦截导航到非本地 URL。
  win.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(DEV_SERVER_URL) || url.startsWith("file://")) {
      return;
    }
    event.preventDefault();
    try {
      if (new URL(url).protocol === "https:") {
        shell.openExternal(url);
      }
    } catch {
      // 忽略
    }
  });

  if (DEV_SERVER_URL) {
    await win.loadURL(DEV_SERVER_URL);
  } else {
    await win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  // 生产环境禁用 DevTools，除非显式 debug。
  if (!process.env["AL_DEBUG"] && !DEV_SERVER_URL) {
    win.webContents.on("before-input-event", (event, input) => {
      if (input.key === "F12" || (input.control && input.shift && input.key.toLowerCase() === "i")) {
        event.preventDefault();
      }
    });
  }

  logger.info("主窗口已创建");
  return win;
}
