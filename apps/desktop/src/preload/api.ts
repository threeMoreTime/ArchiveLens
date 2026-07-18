import type {
  AppInfoResult,
  DiagnosticsResult,
  Event,
  OcrCorpusStatusResult,
  OcrSearchExecuteParams,
  OcrSearchHitsResult,
  OcrSearchPreparePageImageParams,
  OcrSearchSession,
  OcrSearchSessionsResult,
  ReviewDisplayPreferences,
  ReviewHighlightSettingsResult,
  ReviewHighlightSettingsUpdateParams,
  ReviewPageImageResult,
  ReviewPreparePageImageParams,
  SearchScriptScope,
  SourcePreflightJob,
  StorageCleanupResult,
} from "@shared/index";

export interface LocalDataTaskUsage {
  task_id: string;
  derived_bytes: number;
  export_bytes: number;
  total_bytes: number;
}

export interface LocalDataSummary {
  user_data_path: string;
  engine_data_path: string;
  log_path: string;
  total_bytes: number;
  database_bytes: number;
  migration_backup_bytes: number;
  task_derived_bytes: number;
  export_bytes: number;
  temporary_export_bytes: number;
  log_bytes: number;
  settings_bytes: number;
  other_bytes: number;
  file_count: number;
  skipped_link_count: number;
  unreadable_entry_count: number;
  complete: boolean;
  tasks: LocalDataTaskUsage[];
  scanned_at: string;
}

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
  source_kind?: "folder" | "files";
  source_label?: string;
  source_files?: string[];
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
  search_script_scope: SearchScriptScope;
  failures?: TaskFailure[];
  review_preferences?: ReviewDisplayPreferences;
  ocr_corpus_version?: number;
  ocr_index_status?: "not_built" | "building" | "ready" | "partial" | "failed" | "legacy_requires_reocr";
  ocr_model_id?: string | null;
  ocr_model_sha256?: string | null;
  ocr_indexed_pages?: number;
  cleanup_status?: string;
  cleanup_error_summary?: string | null;
}

export interface TaskFailure {
  failure_id?: string;
  file_path: string;
  page_number: number | null;
  stage: string;
  error_type: string;
  error_message: string;
  possible_missed_hits: boolean;
}

export interface ExportRecord {
  export_id: string;
  task_id: string;
  kind: string;
  path: string;
  created_at: string;
}

export type ExportJobStatus =
  | "queued"
  | "preparing"
  | "rendering_images"
  | "building"
  | "writing"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "failed"
  | "interrupted";

export interface ExportJob {
  export_id: string;
  task_id: string;
  format: string;
  status: ExportJobStatus;
  current_stage: string;
  progress_completed: number;
  progress_total: number;
  output_path: string;
  error_code: string;
  error_message: string;
  cancel_requested: boolean;
  retry_of: string;
  cleanup_status: "pending" | "completed" | "failed";
  cleanup_error_code: string;
  cleanup_error_message: string;
  cleanup_attempt_count: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface ExportJobCreateResult {
  export_id: string;
  task_id: string;
  format: string;
  status: string;
  retry_of?: string;
}

export interface OccurrenceItem {
  occurrence_id: string;
  task_id: string;
  document_id: string;
  file_path: string;
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
  source_page_width: number | null;
  source_page_height: number | null;
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
    getLocalDataSummary(): Promise<LocalDataSummary>;
    cleanupTemporaryData(): Promise<StorageCleanupResult>;
    openUserDataDirectory(): Promise<void>;
    openLogDirectory(): Promise<void>;
  };
  dialog: {
    selectFolder(): Promise<string | null>;
    selectFile(): Promise<string | null>;
    selectFiles(p: { multiple: boolean }): Promise<string[] | null>;
  };
  subscribe: {
    onEvent(cb: (event: Event) => void): () => void;
    onEngineExit(cb: (info: EngineExitInfo) => void): () => void;
    onRecoverable(cb: (tasks: unknown[]) => void): () => void;
  };
  tasks: {
    create(p: ({
      source_type?: "folder";
      source_dir: string;
      preflight_token?: string;
      preflight_confirmed?: boolean;
    } | {
      source_type: "files";
      source_files: string[];
    }) & {
      search_text: string;
      search_script_scope?: SearchScriptScope;
      output_dir?: string;
      name?: string;
      parallel_workers?: 1;
      review_preferences?: ReviewDisplayPreferences;
    }): Promise<{
      task_id: string;
      status: string;
      source_dir: string;
      source_kind?: "folder" | "files";
      source_label?: string;
      source_files?: string[];
      file_count: number;
      search_text: string;
      search_terms: string[];
      search_mode: "exact_literal";
      search_script_scope: SearchScriptScope;
      review_preferences?: ReviewDisplayPreferences;
    }>;
    preflight(source_dir: string): Promise<SourcePreflightJob>;
    getPreflight(preflight_id: string): Promise<SourcePreflightJob>;
    cancelPreflight(preflight_id: string): Promise<SourcePreflightJob>;
    start(task_id: string): Promise<{ task_id: string; status: string }>;
    get(task_id: string): Promise<TaskSummary>;
    list(p?: { limit?: number; offset?: number; status?: string; query?: string }): Promise<{ items: TaskSummary[]; limit: number; offset: number; total: number }>;
    pause(task_id: string): Promise<{ task_id: string; status: string }>;
    resume(task_id: string): Promise<{ task_id: string; status: string }>;
    cancel(task_id: string): Promise<{ task_id: string; status: string }>;
    delete(task_id: string): Promise<{ task_id: string; deleted: true }>;
    openCleanupDir(task_id: string): Promise<{ ok: boolean }>;
    openDirectory(task_id: string): Promise<{ ok: boolean }>;
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
  search: {
    getCorpusStatus(task_id: string): Promise<OcrCorpusStatusResult>;
    execute(p: OcrSearchExecuteParams): Promise<OcrSearchSession>;
    listSessions(task_id: string, limit?: number): Promise<OcrSearchSessionsResult>;
    queryHits(p: {
      task_id: string;
      search_session_id: string;
      limit?: number;
      offset?: number;
    }): Promise<OcrSearchHitsResult>;
    preparePageImage(p: OcrSearchPreparePageImageParams): Promise<ReviewPageImageResult>;
  };
  review: {
    preparePageImage(p: ReviewPreparePageImageParams): Promise<ReviewPageImageResult>;
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
    html(task_id: string): Promise<{ path: string; occurrence_count: number; file_size_bytes: number }>;
    list(task_id: string, p?: { limit?: number; offset?: number }): Promise<{ task_id: string; items: ExportRecord[]; limit: number; offset: number }>;
    create(p: { task_id: string; format: "html" | "json" | "review" }): Promise<ExportJobCreateResult>;
    get(export_id: string): Promise<ExportJob>;
    listJobs(task_id: string, p?: { limit?: number; offset?: number }): Promise<{ task_id: string; items: ExportJob[]; limit: number; offset: number; total: number }>;
    cancel(export_id: string): Promise<{ export_id: string; status: string }>;
    retry(export_id: string): Promise<ExportJobCreateResult>;
    openDirectory(export_id: string): Promise<{ ok: boolean }>;
  };
  settings: {
    get(task_id?: string): Promise<ReviewHighlightSettingsResult>;
    update(p: ReviewHighlightSettingsUpdateParams): Promise<ReviewHighlightSettingsResult>;
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
