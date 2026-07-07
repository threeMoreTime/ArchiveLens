import type { AppInfoResult, DiagnosticsResult, Event } from "@shared/index";

/** Main 返回的环境综合信息。 */
export interface EnvironmentInfo {
  appVersion: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  sidecarReady: boolean;
  engine: DiagnosticsResult | null;
}

export interface EngineExitInfo {
  code: number | null;
  signal: string | null;
  stderrTail: string[];
}

/**
 * 暴露给 Renderer 的全部 API（任务 §8.2）。
 *
 * 仅这些方法可达；Renderer 无法接触 ``ipcRenderer`` / ``fs`` / ``child_process``。
 * 随 Phase 3+ 逐步扩展 tasks / results / review / export / files / settings。
 */
export interface ArchiveLensApi {
  app: {
    getInfo(): Promise<AppInfoResult>;
    getEnvironment(): Promise<EnvironmentInfo>;
    openLogDirectory(): Promise<void>;
  };
  dialog: {
    selectFolder(): Promise<string | null>;
    selectFile(): Promise<string | null>;
  };
  subscribe: {
    onEvent(cb: (event: Event) => void): () => void;
    onEngineExit(cb: (info: EngineExitInfo) => void): () => void;
  };
}
