import type { AppInfoResult, DiagnosticsResult, Event } from "@shared/index";

export interface EnvironmentInfo {
  appVersion: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  sidecarReady: boolean;
  startupError: { code: string; message: string; details: Record<string, unknown> } | null;
  engine: DiagnosticsResult | null;
}

export interface EngineExitInfo {
  code: number | null;
  signal: string | null;
  stderrTail: string[];
  expected: boolean;
  reason: "app_shutdown" | "forced_shutdown" | "unexpected_exit";
  kind: "expected_shutdown" | "forced_shutdown" | "unexpected_exit" | "crash";
}

export interface TaskSummary {
  task_id: string;
  name: string;
  source_dir: string;
  output_dir: string;
  workspace_dir: string;
  status: string;
  is_demo: number;
  file_count: number;
  total_pages: number;
  processed_pages: number;
  occurrence_count: number;
  failure_count: number;
  worker_generation: number;
  last_event_sequence: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error_message: string | null;
  search_text: string;
  search_terms: string[];
  search_mode: "exact_literal" | "legacy_fixed_pair";
}

export interface OccurrenceItem {
  occurrence_id: string;
  task_id: string;
  file_name: string;
  relative_path: string;
  page_number: number;
  page_occurrence_index: number;
  matched_character: string | null;
  character_variant: string | null;
  matched_text: string;
  match_start: number | null;
  match_end: number | null;
  unicode_sequence: string | null;
  context_before: string;
  context_after: string;
  context_full: string;
  ocr_confidence: number;
  verification_status: string;
  review_decision: string | null;
  review_note: string | null;
  page_image_relpath: string | null;
  crop_image_relpath: string | null;
  page_image_width: number | null;
  page_image_height: number | null;
  normalized_x0: number;
  normalized_y0: number;
  normalized_x1: number;
  normalized_y1: number;
}

export interface ReviewSummary {
  reviewed_count: number;
  unreviewed_count: number;
  confirmed_count: number;
  needs_review_count: number;
  rejected_count: number;
}

export interface ResultsPage {
  task_id: string;
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
  review_summary: ReviewSummary;
  task_status: string;
  scan_complete: boolean;
  review_complete: boolean;
  items: OccurrenceItem[];
}

export interface DemoResult {
  task_id: string;
  workspace_dir: string;
  status: string;
  occurrence_count: number;
  is_demo: boolean;
}

/**
 * 暴露给 Renderer 的全部 API（任务 §17）。Renderer 不接触 ipcRenderer/fs/child_process。
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
    onRecoverable(cb: (tasks: unknown[]) => void): () => void;
  };
  tasks: {
    create(p: {
      source_dir: string;
      search_text: string;
      output_dir?: string;
      name?: string;
      parallel_workers?: 1;
    }): Promise<{
      task_id: string;
      status: string;
      source_dir: string;
      file_count: number;
      search_text: string;
      search_terms: string[];
      search_mode: "exact_literal";
    }>;
    start(task_id: string): Promise<{ task_id: string; status: string }>;
    get(task_id: string): Promise<TaskSummary>;
    list(p?: { limit?: number; offset?: number; status?: string }): Promise<{ items: TaskSummary[]; limit: number; offset: number }>;
    pause(task_id: string): Promise<{ task_id: string; status: string }>;
    resume(task_id: string): Promise<{ task_id: string; status: string }>;
    cancel(task_id: string): Promise<{ task_id: string; status: string }>;
  };
  demo: {
    create(): Promise<DemoResult>;
  };
  results: {
    query(p: {
      task_id: string;
      limit?: number;
      offset?: number;
      document?: string | null;
      status?: string | null;
      character?: string | null;
      search?: string | null;
    }): Promise<ResultsPage>;
    getDetail(p: { task_id: string; occurrence_id: string }): Promise<OccurrenceItem>;
  };
  review: {
    updateDecision(p: {
      task_id: string;
      occurrence_id: string;
      decision: "confirmed" | "needs_review" | "rejected";
    }): Promise<{ occurrence_id: string; decision: string; updated_at: string }>;
    updateNote(p: {
      task_id: string;
      occurrence_id: string;
      note: string;
    }): Promise<{ occurrence_id: string; note: string; updated_at: string }>;
  };
  export: {
    json(task_id: string): Promise<{ path: string; occurrence_count: number }>;
    review(task_id: string): Promise<{ path: string; record_count: number }>;
    html(task_id: string): Promise<{ path: string; occurrence_count: number }>;
  };
  files: {
    openFolder(path: string): Promise<{ ok: boolean }>;
    openOriginal(path: string): Promise<{ ok: boolean }>;
  };
  test?: {
    lifecycle: {
      requestClose(): Promise<unknown>;
      selectCloseAction(action: {
        action: "minimize" | "cancel" | "pause_and_quit" | "stop_and_quit" | "continue_waiting" | "force_quit";
      }): Promise<unknown>;
      getState(): Promise<unknown>;
    };
    tray: {
      getState(): Promise<unknown>;
      restoreWindow(): Promise<unknown>;
    };
    window: {
      getState(): Promise<unknown>;
    };
    engine: {
      getPid(): Promise<unknown>;
    };
    sidecar: {
      simulateCrash(): Promise<unknown>;
    };
    task: {
      getState(task_id: string): Promise<unknown>;
      getProcessedPageIds(task_id: string): Promise<unknown>;
      getOccurrenceIds(task_id: string): Promise<unknown>;
      getCheckpoint(task_id: string): Promise<unknown>;
      getEventSequence(task_id: string): Promise<unknown>;
    };
  };
}

/** 拼接受限资源协议 URL（不暴露绝对路径）。 */
export function assetUrl(taskId: string, relpath: string | null | undefined): string {
  if (!relpath) return "";
  return `al-resource://${taskId}/${relpath.replace(/^\/+/, "")}`;
}
