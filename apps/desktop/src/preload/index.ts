import { contextBridge, ipcRenderer } from "electron";
import type { ArchiveLensApi, EngineExitInfo } from "./api";
import type { Event } from "@shared/index";

const api: ArchiveLensApi = {
  app: {
    getInfo: () => ipcRenderer.invoke("app.getInfo"),
    getVersion: () => ipcRenderer.invoke("app.getVersion"),
    getEnvironment: () => ipcRenderer.invoke("app.getEnvironment"),
    getLocalDataSummary: () => ipcRenderer.invoke("app.getLocalDataSummary"),
    cleanupTemporaryData: () => ipcRenderer.invoke("app.cleanupTemporaryData"),
    openUserDataDirectory: () => ipcRenderer.invoke("app.openUserDataDirectory"),
    openLogDirectory: () => ipcRenderer.invoke("app.openLogDirectory"),
    getDeveloperSnapshot: (p) => ipcRenderer.invoke("app.getDeveloperSnapshot", p ?? {}),
    reportRendererError: (p) => ipcRenderer.invoke("app.reportRendererError", p),
    copyDiagnosticSummary: (p) => ipcRenderer.invoke("app.copyDiagnosticSummary", p),
    copyAiDebugInfo: (p) => ipcRenderer.invoke("app.copyAiDebugInfo", p),
    openRendererDevTools: () => ipcRenderer.invoke("app.openRendererDevTools"),
  },
  dialog: {
    selectFolder: () => ipcRenderer.invoke("dialog.selectFolder"),
    selectFile: () => ipcRenderer.invoke("dialog.selectFile"),
    selectFiles: (p) => ipcRenderer.invoke("dialog.selectFiles", p),
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
    preflight: (source_dir) => ipcRenderer.invoke("tasks.preflight", { source_dir }),
    getPreflight: (preflight_id) => ipcRenderer.invoke("tasks.preflightGet", { preflight_id }),
    cancelPreflight: (preflight_id) => ipcRenderer.invoke("tasks.preflightCancel", { preflight_id }),
    start: (task_id) => ipcRenderer.invoke("tasks.start", { task_id }),
    get: (task_id) => ipcRenderer.invoke("tasks.get", { task_id }),
    list: (p) => ipcRenderer.invoke("tasks.list", p ?? {}),
    pause: (task_id) => ipcRenderer.invoke("tasks.pause", { task_id }),
    resume: (task_id) => ipcRenderer.invoke("tasks.resume", { task_id }),
    cancel: (task_id) => ipcRenderer.invoke("tasks.cancel", { task_id }),
    delete: (task_id) => ipcRenderer.invoke("tasks.delete", { task_id }),
    openCleanupDir: (task_id) => ipcRenderer.invoke("tasks.openCleanupDir", { task_id }),
    openDirectory: (task_id) => ipcRenderer.invoke("tasks.openDirectory", { task_id }),
  },
  demo: {
    create: () => ipcRenderer.invoke("demo.create"),
  },
  results: {
    query: (p) => ipcRenderer.invoke("results.query", p),
    getDetail: (p) => ipcRenderer.invoke("results.getDetail", p),
  },
  search: {
    getCorpusStatus: (task_id) => ipcRenderer.invoke("search.corpusStatus", { task_id }),
    execute: (p) => ipcRenderer.invoke("search.execute", p),
    listSessions: (task_id, limit) => ipcRenderer.invoke("search.sessions", { task_id, ...(limit ? { limit } : {}) }),
    queryHits: (p) => ipcRenderer.invoke("search.hits", p),
    preparePageImage: (p) => ipcRenderer.invoke("search.preparePageImage", p),
  },
  review: {
    preparePageImage: (p) => ipcRenderer.invoke("review.preparePageImage", p),
    getLayoutContext: (p) => ipcRenderer.invoke("review.layoutContext", p),
    previewLayoutContext: (p) => ipcRenderer.invoke("review.previewLayoutContext", p),
    updateLayoutOverride: (p) => ipcRenderer.invoke("review.updateLayoutOverride", p),
    rebuildLayoutContexts: (p) => ipcRenderer.invoke("review.rebuildLayoutContexts", p),
    updateDecision: (p) => ipcRenderer.invoke("review.updateDecision", p),
    updateDecisions: (p) => ipcRenderer.invoke("review.updateDecisions", p),
    updateNote: (p) => ipcRenderer.invoke("review.updateNote", p),
  },
  export: {
    json: (task_id) => ipcRenderer.invoke("export.json", { task_id }),
    review: (task_id) => ipcRenderer.invoke("export.review", { task_id }),
    html: (task_id) => ipcRenderer.invoke("export.html", { task_id }),
    list: (task_id, p) => ipcRenderer.invoke("exports.list", { task_id, ...(p ?? {}) }),
    create: (p) => ipcRenderer.invoke("exports.create", p),
    get: (export_id) => ipcRenderer.invoke("exports.get", { export_id }),
    listJobs: (task_id, p) => ipcRenderer.invoke("exports.listJobs", { task_id, ...(p ?? {}) }),
    cancel: (export_id) => ipcRenderer.invoke("exports.cancel", { export_id }),
    retry: (export_id) => ipcRenderer.invoke("exports.retry", { export_id }),
    openDirectory: (export_id) => ipcRenderer.invoke("exports.openDirectory", { export_id }),
  },
  settings: {
    get: (task_id) => ipcRenderer.invoke("settings.get", task_id ? { task_id } : {}),
    update: (p) => ipcRenderer.invoke("settings.update", p),
    getDeveloperMode: () => ipcRenderer.invoke("settings.getDeveloperMode"),
    setDeveloperMode: (p) => ipcRenderer.invoke("settings.setDeveloperMode", p),
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
