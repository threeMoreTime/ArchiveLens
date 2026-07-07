import { contextBridge, ipcRenderer } from "electron";
import type { ArchiveLensApi, EngineExitInfo } from "./api";
import type { Event } from "@shared/index";

/**
 * 通过 contextBridge 暴露类型化、最小化的 API。
 *
 * 不暴露 ``ipcRenderer`` 本身、不暴露 ``on(channel, ...)`` 通用订阅，
 * 仅提供显式方法与显式事件订阅（带取消）。
 */
const api: ArchiveLensApi = {
  app: {
    getInfo: () => ipcRenderer.invoke("app.getInfo"),
    getEnvironment: () => ipcRenderer.invoke("app.getEnvironment"),
    openLogDirectory: () => ipcRenderer.invoke("app.openLogDirectory"),
  },
  dialog: {
    selectFolder: () => ipcRenderer.invoke("dialog.selectFolder"),
    selectFile: () => ipcRenderer.invoke("dialog.selectFile"),
  },
  subscribe: {
    onEvent: (cb: (event: Event) => void) => {
      const handler = (_: unknown, payload: Event) => cb(payload);
      ipcRenderer.on("archiveLens:event", handler);
      return () => {
        ipcRenderer.off("archiveLens:event", handler);
      };
    },
    onEngineExit: (cb: (info: EngineExitInfo) => void) => {
      const handler = (_: unknown, payload: EngineExitInfo) => cb(payload);
      ipcRenderer.on("archiveLens:engineExit", handler);
      return () => {
        ipcRenderer.off("archiveLens:engineExit", handler);
      };
    },
  },
};

contextBridge.exposeInMainWorld("archiveLens", api);
