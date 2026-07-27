import { BrowserWindow, Menu, shell } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveApplicationIconPath } from "../appIcon";
import { logger } from "../logging/logger";
import { isAllowedAppNavigation } from "../security/navigation";

const DEV_SERVER_URL = process.env["ELECTRON_RENDERER_URL"] ?? "";

/** 生产环境是否禁用 DevTools（AL_DEBUG=1 或开发服务器时不禁用）。 */
const isProduction = !process.env["AL_DEBUG"] && !DEV_SERVER_URL;

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
  const rendererEntryUrl = DEV_SERVER_URL || pathToFileURL(join(__dirname, "../renderer/index.html")).toString();
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#f4efe7",
    title: "ArchiveLens",
    icon: resolveApplicationIconPath(),
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
        void shell.openExternal(url).catch((error: unknown) => {
          logger.warn(`打开外部链接失败：${error instanceof Error ? error.message : String(error)}`);
        });
      }
    } catch {
      // 非法 URL 直接拒绝。
    }
    return { action: "deny" };
  });

  // 拦截导航到非本地 URL。
  win.webContents.on("will-navigate", (event, url) => {
    if (isAllowedAppNavigation(url, rendererEntryUrl)) {
      return;
    }
    event.preventDefault();
    try {
      if (new URL(url).protocol === "https:") {
        void shell.openExternal(url).catch((error: unknown) => {
          logger.warn(`打开外部链接失败：${error instanceof Error ? error.message : String(error)}`);
        });
      }
    } catch {
      // 忽略
    }
  });

  await win.loadURL(rendererEntryUrl);

  // 生产环境禁用 DevTools，除非显式 debug（AL_DEBUG=1）或开发服务器。
  if (isProduction) {
    // 移除默认 application menu——默认菜单含 View → Toggle Developer Tools，
    // 用户可通过 Alt 恢复菜单并从菜单栏打开 DevTools。
    Menu.setApplicationMenu(null);

    // 拦截所有平台的 DevTools 快捷键。
    win.webContents.on("before-input-event", (event, input) => {
      const key = input.key.toLowerCase();
      // F12：Windows/Linux DevTools
      // Ctrl+Shift+I：DevTools（全平台）
      // Ctrl+Shift+J：Console（全平台）
      // Ctrl+Shift+C：Element Inspector（全平台）
      // Ctrl+Shift+K：Firefox 兼容 Console
      // Cmd+Option+I/J/C：macOS DevTools/Console/Inspector
      const isMac = process.platform === "darwin";
      const isDevToolsShortcut =
        input.key === "F12"
        || (input.control && input.shift && ["i", "j", "c", "k"].includes(key))
        || (isMac && input.meta && input.alt && ["i", "j", "c"].includes(key));
      if (isDevToolsShortcut) {
        event.preventDefault();
      }
    });
  }

  logger.info("主窗口已创建");
  return win;
}
