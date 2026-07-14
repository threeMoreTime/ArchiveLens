import { app, BrowserWindow, Menu, nativeImage, shell, Tray } from "electron";
import { logger } from "./logging/logger";

/**
 * 系统托盘（任务 §六）。
 *
 * 单例：只创建一次；窗口隐藏后保持；点击恢复并聚焦；退出时安全销毁。
 * 使用内嵌 PNG 生成可见图标，避免依赖未随包的本机资源文件。
 */

let tray: Tray | null = null;
let trayWindowGetter: (() => BrowserWindow | null) | null = null;

const TRAY_ICON_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAQklEQVR42mMw9M77P5CYYdQBow7AJfHl/XOq4lEHjDpgaDuA3Cw2GgWjDhhNhKMOGE2Eo1Ew6oCh7YDRfsGoA+iFAZd8jtc0U6yAAAAAAElFTkSuQmCC";

function createTrayIcon() {
  const icon = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_PNG_BASE64, "base64"));
  if (icon.isEmpty()) {
    throw new Error("无法创建 ArchiveLens 托盘图标");
  }
  return icon.resize({ width: 16, height: 16 });
}

export function createTray(getWin: () => BrowserWindow | null): Tray {
  if (tray) {
    return tray;
  }
  trayWindowGetter = getWin;
  const icon = createTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip("ArchiveLens");
  rebuildMenu(getWin);
  tray.on("click", () => {
    const win = getWin();
    if (!win) {
      return;
    }
    if (win.isMinimized() || !win.isVisible()) {
      win.show();
    }
    win.focus();
  });
  logger.info("托盘已创建");
  return tray;
}

function rebuildMenu(getWin: () => BrowserWindow | null) {
  if (!tray) {
    return;
  }
  const menu = Menu.buildFromTemplate([
    {
      label: "打开 ArchiveLens",
      click: () => {
        const win = getWin();
        if (win) {
          win.show();
          win.focus();
        }
      },
    },
    {
      label: "查看当前任务",
      click: () => {
        const win = getWin();
        if (win) {
          win.webContents.send("archiveLens:navigate", "/tasks/current");
        }
      },
    },
    { type: "separator" },
    {
      label: "打开日志目录",
      click: () => {
        void shell.openPath(logger.logDirectory);
      },
    },
    {
      label: "退出",
      click: () => {
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

export function updateTrayTooltip(text: string): void {
  if (tray) {
    tray.setToolTip(text);
  }
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
    trayWindowGetter = null;
    logger.info("托盘已销毁");
  }
}

export function restoreTrayWindow(): boolean {
  const win = trayWindowGetter?.();
  if (!win || win.isDestroyed()) {
    return false;
  }
  if (win.isMinimized() || !win.isVisible()) {
    win.show();
  }
  win.focus();
  return true;
}

export function getTrayState(): { present: boolean } {
  return { present: tray !== null };
}
