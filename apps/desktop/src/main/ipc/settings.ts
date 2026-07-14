import { app, ipcMain } from "electron";
import { join } from "node:path";
import {
  ReviewHighlightSettingsGetParamsSchema,
  ReviewHighlightSettingsUpdateParamsSchema,
} from "@shared/index";
import { logger } from "../logging/logger";
import { SettingsStore } from "../settings/store";

let settingsStore: SettingsStore | null = null;

export function getSettingsStore(): SettingsStore {
  if (!settingsStore) {
    settingsStore = new SettingsStore(
      join(app.getPath("userData"), "settings.json"),
      (message) => logger.warn(message),
    );
  }
  return settingsStore;
}

export function registerSettingsHandlers(): void {
  ipcMain.handle("settings.get", async (_event, params: unknown = {}) => {
    const parsed = ReviewHighlightSettingsGetParamsSchema.parse(params);
    return getSettingsStore().get(parsed.task_id);
  });
  ipcMain.handle("settings.update", async (_event, params: unknown) => {
    return getSettingsStore().update(ReviewHighlightSettingsUpdateParamsSchema.parse(params));
  });
}
