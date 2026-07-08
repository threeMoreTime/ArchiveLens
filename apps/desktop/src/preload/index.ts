import { contextBridge, ipcRenderer } from "electron";
import type { ArchiveLensApi, EngineExitInfo } from "./api";
import type { Event } from "@shared/index";

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
      return () => ipcRenderer.off("archiveLens:event", handler);
    },
    onEngineExit: (cb: (info: EngineExitInfo) => void) => {
      const handler = (_: unknown, payload: EngineExitInfo) => cb(payload);
      ipcRenderer.on("archiveLens:engineExit", handler);
      return () => ipcRenderer.off("archiveLens:engineExit", handler);
    },
    onRecoverable: (cb: (tasks: unknown[]) => void) => {
      const handler = (_: unknown, payload: unknown[]) => cb(payload);
      ipcRenderer.on("archiveLens:recoverable", handler);
      return () => ipcRenderer.off("archiveLens:recoverable", handler);
    },
  },
  tasks: {
    create: (p) => ipcRenderer.invoke("tasks.create", p),
    start: (task_id) => ipcRenderer.invoke("tasks.start", { task_id }),
    get: (task_id) => ipcRenderer.invoke("tasks.get", { task_id }),
    list: (p) => ipcRenderer.invoke("tasks.list", p ?? {}),
    pause: (task_id) => ipcRenderer.invoke("tasks.pause", { task_id }),
    resume: (task_id) => ipcRenderer.invoke("tasks.resume", { task_id }),
    cancel: (task_id) => ipcRenderer.invoke("tasks.cancel", { task_id }),
  },
  demo: {
    create: () => ipcRenderer.invoke("demo.create"),
  },
  results: {
    query: (p) => ipcRenderer.invoke("results.query", p),
    getDetail: (p) => ipcRenderer.invoke("results.getDetail", p),
  },
  review: {
    updateDecision: (p) => ipcRenderer.invoke("review.updateDecision", p),
    updateNote: (p) => ipcRenderer.invoke("review.updateNote", p),
  },
  export: {
    json: (task_id) => ipcRenderer.invoke("export.json", { task_id }),
    review: (task_id) => ipcRenderer.invoke("export.review", { task_id }),
    html: (task_id) => ipcRenderer.invoke("export.html", { task_id }),
  },
  files: {
    openFolder: (path) => ipcRenderer.invoke("files.openFolder", { path }),
    openOriginal: (path) => ipcRenderer.invoke("files.openOriginal", { path }),
  },
};

if (process.env["ARCHIVELENS_E2E"] === "1") {
  api.test = {
    lifecycle: {
      requestClose: () => ipcRenderer.invoke("test.lifecycle.requestClose"),
      selectCloseAction: (action) => ipcRenderer.invoke("test.lifecycle.selectCloseAction", action),
      getState: () => ipcRenderer.invoke("test.lifecycle.getState"),
    },
    tray: {
      getState: () => ipcRenderer.invoke("test.tray.getState"),
      restoreWindow: () => ipcRenderer.invoke("test.tray.restoreWindow"),
    },
    window: {
      getState: () => ipcRenderer.invoke("test.window.getState"),
    },
    engine: {
      getPid: () => ipcRenderer.invoke("test.engine.getPid"),
    },
    sidecar: {
      simulateCrash: () => ipcRenderer.invoke("test.sidecar.simulateCrash"),
    },
    task: {
      getState: (task_id) => ipcRenderer.invoke("test.task.getState", { task_id }),
      getProcessedPageIds: (task_id) => ipcRenderer.invoke("test.task.getProcessedPageIds", { task_id }),
      getOccurrenceIds: (task_id) => ipcRenderer.invoke("test.task.getOccurrenceIds", { task_id }),
      getCheckpoint: (task_id) => ipcRenderer.invoke("test.task.getCheckpoint", { task_id }),
      getEventSequence: (task_id) => ipcRenderer.invoke("test.task.getEventSequence", { task_id }),
    },
  };
}

contextBridge.exposeInMainWorld("archiveLens", api);
