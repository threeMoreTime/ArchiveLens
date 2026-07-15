import { app } from "electron";
import { join } from "node:path";

function resolveIcon(developmentName: string, packagedName: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, packagedName)
    : join(app.getAppPath(), "resources", developmentName);
}

export function resolveApplicationIconPath(): string {
  return resolveIcon("icon.png", "app-icon.png");
}

export function resolveTrayIconPath(): string {
  return resolveIcon("icon-32.png", "tray-icon.png");
}
