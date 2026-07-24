import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DeveloperSnapshotSchema,
  MAX_AI_DEBUG_LOG_LINES,
  PROTOCOL_VERSION,
  type BuildMetadata,
  type DeveloperSnapshot,
  type DeveloperSnapshotTask,
  type KnownErrorSnapshot,
} from "@shared/index";
import type { LocalDataSummary } from "../localData";

/**
 * 受限开发者操作在门禁关闭时使用的错误码。
 *
 * 属于 Electron 本地边界，不进入 Python `ErrorCode` 闭合枚举。
 */
export const DEVELOPER_MODE_REQUIRED = "DEVELOPER_MODE_REQUIRED";

export class DeveloperModeRequiredError extends Error {
  readonly code = DEVELOPER_MODE_REQUIRED;
  constructor(message = "开发者模式未开启，已拒绝该操作") {
    super(message);
    this.name = "DeveloperModeRequiredError";
  }
}

/** 门禁：开发者模式关闭时抛 {@link DeveloperModeRequiredError}。 */
export function assertDeveloperModeEnabled(enabled: boolean): void {
  if (!enabled) throw new DeveloperModeRequiredError();
}

/** Main 组装开发者快照所需的运行时信息（由 Electron `app`/`process` 填充）。 */
export interface DeveloperRuntimeInfo {
  app_version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  user_data_path: string;
  engine_data_path: string;
  log_path: string;
  user_name: string;
  home_dir: string;
}

export interface DeveloperSidecarLike {
  readonly isReady: boolean;
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

export interface DeveloperDiagnosticsDeps {
  runtime: DeveloperRuntimeInfo;
  sidecar: DeveloperSidecarLike;
  collectLocalData: (userDataPath: string) => Promise<LocalDataSummary>;
  loadDesktopBuildInfo: () => BuildMetadata | null;
  snapshotForTask: (taskId: string) => KnownErrorSnapshot | null;
  lastKnownError: () => KnownErrorSnapshot | null;
}

interface AppInfoLike {
  engine_version?: string;
  python_executable?: string;
  build_metadata?: { git_commit?: string } | null;
}

interface DiagnosticsCheckLike {
  key: string;
  label: string;
  status: string;
  detail?: string;
  impact?: string;
  remedy?: string;
  extra?: Record<string, string>;
}

function collectionError(section: string, error: unknown): { section: string; message: string } {
  return { section, message: error instanceof Error ? error.message : String(error) };
}

async function settle<T>(promise: Promise<T>): Promise<{ value: T | null; error: unknown }> {
  try {
    return { value: await promise, error: null };
  } catch (error) {
    return { value: null, error };
  }
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * 组装开发者快照（任务 §五）。
 *
 * 每个分区独立用 allSettled 收集，任一失败只写入 collection_errors，其余分区照常返回；
 * 没有当前任务时 current_task 为 null，且绝不加载全部任务列表。
 */
export async function collectDeveloperSnapshot(
  deps: DeveloperDiagnosticsDeps,
  params: { task_id?: string } = {},
): Promise<DeveloperSnapshot> {
  const collectionErrors: Array<{ section: string; message: string }> = [];

  const [appInfoResult, diagnosticsResult, localDataResult] = await Promise.all([
    settle(deps.sidecar.call<AppInfoLike>("app.info", {})),
    settle(deps.sidecar.call<{ overall?: string; checks?: DiagnosticsCheckLike[] }>("diagnostics.run", {})),
    settle(deps.collectLocalData(deps.runtime.user_data_path)),
  ]);

  if (appInfoResult.error) collectionErrors.push(collectionError("build_runtime.engine", appInfoResult.error));
  if (diagnosticsResult.error) collectionErrors.push(collectionError("checks", diagnosticsResult.error));
  if (localDataResult.error) collectionErrors.push(collectionError("local_data", localDataResult.error));

  const appInfo = appInfoResult.value;
  const localData = localDataResult.value;
  const desktopBuildInfo = deps.loadDesktopBuildInfo();

  const build_runtime = {
    app_version: deps.runtime.app_version,
    engine_version: appInfo?.engine_version ?? null,
    protocol_version: PROTOCOL_VERSION,
    desktop_commit: desktopBuildInfo?.git_commit ?? null,
    engine_commit: appInfo?.build_metadata?.git_commit ?? null,
    electron: deps.runtime.electron,
    chrome: deps.runtime.chrome,
    node: deps.runtime.node,
    python: appInfo?.python_executable ?? null,
    platform: deps.runtime.platform,
    arch: deps.runtime.arch,
    sidecar_ready: deps.sidecar.isReady,
    sidecar_status: deps.sidecar.isReady ? "ready" : "not_ready",
  };

  const checks = (diagnosticsResult.value?.checks ?? []).map((check) => ({
    key: check.key,
    label: check.label,
    status: check.status,
    detail: check.detail ?? "",
    impact: check.impact ?? "",
    remedy: check.remedy ?? "",
    source: check.extra?.["source"] ?? "",
    path: check.extra?.["path"] ?? "",
  }));

  const local_data = {
    user_data_path: localData?.user_data_path ?? deps.runtime.user_data_path,
    engine_data_path: localData?.engine_data_path ?? deps.runtime.engine_data_path,
    log_path: localData?.log_path ?? deps.runtime.log_path,
    python_executable: appInfo?.python_executable ?? null,
    total_bytes: localData?.total_bytes ?? 0,
    database_bytes: localData?.database_bytes ?? 0,
    migration_backup_bytes: localData?.migration_backup_bytes ?? 0,
    task_derived_bytes: localData?.task_derived_bytes ?? 0,
    export_bytes: localData?.export_bytes ?? 0,
    temporary_export_bytes: localData?.temporary_export_bytes ?? 0,
    log_bytes: localData?.log_bytes ?? 0,
    settings_bytes: localData?.settings_bytes ?? 0,
    other_bytes: localData?.other_bytes ?? 0,
    complete: localData?.complete ?? false,
  };

  let current_task: DeveloperSnapshotTask | null = null;
  if (params.task_id) {
    current_task = await collectTaskSection(deps, params.task_id, collectionErrors);
  }

  const snapshot = {
    generated_at: new Date().toISOString(),
    build_runtime,
    checks,
    local_data,
    current_task,
    last_known_error: deps.lastKnownError(),
    collection_errors: collectionErrors,
  };
  return DeveloperSnapshotSchema.parse(snapshot);
}

async function collectTaskSection(
  deps: DeveloperDiagnosticsDeps,
  taskId: string,
  collectionErrors: Array<{ section: string; message: string }>,
): Promise<DeveloperSnapshotTask | null> {
  const [taskResult, resultsResult, exportsResult] = await Promise.all([
    settle(deps.sidecar.call<Record<string, unknown>>("tasks.get", { task_id: taskId })),
    settle(deps.sidecar.call<{ layout_rebuild?: Record<string, unknown> }>("results.query", { task_id: taskId, limit: 1 })),
    settle(deps.sidecar.call<{ items?: Array<Record<string, unknown>> }>("exports.listJobs", { task_id: taskId, limit: 20 })),
  ]);

  if (taskResult.error) collectionErrors.push(collectionError("current_task", taskResult.error));
  if (resultsResult.error) collectionErrors.push(collectionError("current_task.layout_rebuild", resultsResult.error));
  if (exportsResult.error) collectionErrors.push(collectionError("current_task.exports", exportsResult.error));

  const task = taskResult.value;
  if (!task) {
    // 任务技术状态获取失败：保留 task_id 与最近已知错误，其余字段留空。
    return {
      task_id: taskId,
      status: "unavailable",
      workspace_path: null,
      ocr_model_id: null,
      ocr_model_sha256: null,
      ocr_index_status: null,
      ocr_indexed_pages: null,
      ocr_corpus_version: null,
      processed_pages: 0,
      total_pages: 0,
      occurrence_count: 0,
      layout_rebuild: null,
      failures: [],
      last_failed_export: null,
      last_known_error: deps.snapshotForTask(taskId),
    };
  }

  const failedExports = (exportsResult.value?.items ?? []).filter(
    (job) => job["status"] === "failed" || job["status"] === "interrupted",
  );
  const lastFailedExport = failedExports.length > 0 ? failedExports[failedExports.length - 1]! : null;
  const failures = Array.isArray(task["failures"]) ? (task["failures"] as Array<Record<string, unknown>>) : [];

  return {
    task_id: taskId,
    status: toStringOrNull(task["status"]) ?? "unknown",
    workspace_path: toStringOrNull(task["workspace_dir"]),
    ocr_model_id: toStringOrNull(task["ocr_model_id"]),
    ocr_model_sha256: toStringOrNull(task["ocr_model_sha256"]),
    ocr_index_status: toStringOrNull(task["ocr_index_status"]),
    ocr_indexed_pages: toNumberOrNull(task["ocr_indexed_pages"]),
    ocr_corpus_version: toNumberOrNull(task["ocr_corpus_version"]),
    processed_pages: toNumberOrNull(task["processed_pages"]) ?? 0,
    total_pages: toNumberOrNull(task["total_pages"]) ?? 0,
    occurrence_count: toNumberOrNull(task["occurrence_count"]) ?? 0,
    layout_rebuild: resultsResult.value?.layout_rebuild ?? null,
    failures,
    last_failed_export: lastFailedExport,
    last_known_error: deps.snapshotForTask(taskId),
  };
}

// --------------------------------------------------------------------------- //
// 脱敏工具与三种剪贴板报告构造（全部为纯函数，便于单测）
// --------------------------------------------------------------------------- //

/** 用占位符替换用户名与用户目录；对 Windows/POSIX 用户路径追加兜底脱敏。 */
export function redactText(value: string, userName: string, homeDir: string): string {
  let out = value;
  if (homeDir) out = out.split(homeDir).join("<用户目录>");
  if (userName) {
    out = out.replace(new RegExp(userName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "<用户名>");
  }
  out = out.replace(/([A-Za-z]:\\Users\\)[^\\/]+/gi, "$1<用户名>");
  out = out.replace(/(\/(?:home|Users)\/)[^/]+/g, "$1<用户名>");
  return out;
}

function existenceLine(label: string, present: boolean): string {
  return `- ${label}：${present ? "存在" : "缺失或为空"}`;
}

function currentErrorLines(snapshot: DeveloperSnapshot, currentError?: { code?: string; message?: string; task_id?: string | null }): string[] {
  const known = snapshot.last_known_error;
  const lines: string[] = [];
  if (currentError?.code || currentError?.message) {
    lines.push(`- 当前错误码：${currentError.code ?? "未提供"}`);
    if (currentError.task_id) lines.push(`- 当前错误任务：${currentError.task_id}`);
  }
  if (known) lines.push(`- 最近一次已知错误码：${known.code}（来源 ${known.source}，操作 ${known.operation}）`);
  if (lines.length === 0) lines.push("- 当前没有已登记的错误");
  return lines;
}

/** 脱敏诊断摘要：版本、状态、错误码、任务 ID、检查结果、路径是否存在；不含用户名/路径/文件名/OCR/日志。 */
export function buildRedactedSummary(
  snapshot: DeveloperSnapshot,
  currentError?: { code?: string; message?: string; task_id?: string | null },
): string {
  const { build_runtime: runtime, local_data: data } = snapshot;
  const lines: string[] = [
    "# ArchiveLens 诊断摘要（脱敏）",
    `生成时间：${snapshot.generated_at}`,
    "",
    "## 版本与运行时",
    `- ArchiveLens：${runtime.app_version}`,
    `- Engine：${runtime.engine_version ?? "未连接"} · 协议 v${runtime.protocol_version}`,
    `- Electron ${runtime.electron} · Chrome ${runtime.chrome} · Node ${runtime.node}`,
    `- 平台：${runtime.platform}/${runtime.arch} · 本地识别服务：${runtime.sidecar_ready ? "已连接" : "未连接"}`,
    "",
    "## 组件与能力检查",
    ...(snapshot.checks.length > 0
      ? snapshot.checks.map((check) => `- ${check.label}：${check.status}`)
      : ["- 未获取到检查结果"]),
    "",
    "## 本地路径是否存在（不含具体路径）",
    existenceLine("数据库", data.database_bytes > 0),
    existenceLine("迁移备份", data.migration_backup_bytes > 0),
    existenceLine("任务派生数据", data.task_derived_bytes > 0),
    existenceLine("日志", data.log_bytes > 0),
    existenceLine("Python 可执行文件", data.python_executable !== null),
    `- 占用统计是否完整：${data.complete ? "是" : "否"}`,
    "",
    "## 当前任务",
    ...(snapshot.current_task
      ? [`- 任务 ID：${snapshot.current_task.task_id}`, `- 状态：${snapshot.current_task.status}`, `- 失败明细数：${snapshot.current_task.failures.length}`]
      : ["- 未选择当前任务"]),
    "",
    "## 错误",
    ...currentErrorLines(snapshot, currentError),
  ];
  if (snapshot.collection_errors.length > 0) {
    lines.push("", "## 采集告警", ...snapshot.collection_errors.map((entry) => `- ${entry.section}：${entry.message}`));
  }
  // 二次脱敏兜底：即便检查项 label 意外携带路径/用户名也不外泄。
  return redactTextWithRuntime(lines.join("\n"), snapshot);
}

function redactTextWithRuntime(text: string, snapshot: DeveloperSnapshot): string {
  const userSegment = snapshot.local_data.user_data_path.match(/[\\/]Users[\\/]([^\\/]+)/i)?.[1] ?? "";
  return redactText(text, userSegment, "");
}

/** 完整路径诊断摘要：保留完整路径、文件名、原始错误；不含 OCR 上下文与日志。 */
export function buildFullPathSummary(
  snapshot: DeveloperSnapshot,
  currentError?: { code?: string; message?: string; task_id?: string | null },
): string {
  const { build_runtime: runtime, local_data: data } = snapshot;
  const lines: string[] = [
    "# ArchiveLens 诊断摘要（含完整路径）",
    `生成时间：${snapshot.generated_at}`,
    "注意：包含用户名、目录与文件名；不含 OCR 正文与日志。",
    "",
    "## 版本与运行时",
    `- ArchiveLens：${runtime.app_version}`,
    `- Engine：${runtime.engine_version ?? "未连接"} · 协议 v${runtime.protocol_version}`,
    `- Desktop commit：${runtime.desktop_commit ?? "开发构建未记录"} · Engine commit：${runtime.engine_commit ?? "开发构建未记录"}`,
    `- Electron ${runtime.electron} · Chrome ${runtime.chrome} · Node ${runtime.node} · Python ${runtime.python ?? "未知"}`,
    `- 平台：${runtime.platform}/${runtime.arch} · 本地识别服务：${runtime.sidecar_status}`,
    "",
    "## 组件与能力检查",
    ...(snapshot.checks.length > 0
      ? snapshot.checks.flatMap((check) => [
        `- ${check.label}（${check.key}）：${check.status}`,
        check.detail ? `  详情：${check.detail}` : "",
        check.source ? `  来源：${check.source}` : "",
        check.path ? `  路径：${check.path}` : "",
      ].filter(Boolean))
      : ["- 未获取到检查结果"]),
    "",
    "## 本地路径与占用",
    `- userData：${data.user_data_path}`,
    `- Engine 数据目录：${data.engine_data_path}`,
    `- 日志目录：${data.log_path}`,
    `- Python 可执行文件：${data.python_executable ?? "未知"}`,
    `- 合计 ${data.total_bytes} B · 数据库 ${data.database_bytes} B · 迁移备份 ${data.migration_backup_bytes} B`,
    `- 任务派生 ${data.task_derived_bytes} B · 导出 ${data.export_bytes} B · 临时残留 ${data.temporary_export_bytes} B · 日志 ${data.log_bytes} B`,
    `- 占用统计是否完整：${data.complete ? "是" : "否"}`,
    "",
    "## 当前任务技术状态",
    ...currentTaskFullLines(snapshot.current_task),
    "",
    "## 错误",
    ...currentErrorLines(snapshot, currentError),
    ...(snapshot.last_known_error?.message ? [`- 最近错误原文：${snapshot.last_known_error.message}`] : []),
  ];
  if (snapshot.collection_errors.length > 0) {
    lines.push("", "## 采集告警", ...snapshot.collection_errors.map((entry) => `- ${entry.section}：${entry.message}`));
  }
  return lines.join("\n");
}

function currentTaskFullLines(task: DeveloperSnapshotTask | null): string[] {
  if (!task) return ["- 未选择当前任务"];
  const lines = [
    `- 任务 ID：${task.task_id}`,
    `- 原始状态：${task.status}`,
    `- workspace：${task.workspace_path ?? "未知"}`,
    `- OCR 模型：${task.ocr_model_id ?? "未知"} · sha256 ${task.ocr_model_sha256 ?? "未知"}`,
    `- 索引状态：${task.ocr_index_status ?? "未知"} · 已索引页数 ${task.ocr_indexed_pages ?? "未知"} · 语料版本 ${task.ocr_corpus_version ?? "未知"}`,
    `- 处理进度：${task.processed_pages}/${task.total_pages} · 命中 ${task.occurrence_count}`,
    `- 版面重建：${task.layout_rebuild ? JSON.stringify(task.layout_rebuild) : "无"}`,
    `- 失败明细数：${task.failures.length}`,
  ];
  task.failures.forEach((failure, index) => {
    lines.push(`  失败[${index + 1}]：${JSON.stringify(failure)}`);
  });
  if (task.last_failed_export) lines.push(`- 最近失败导出：${JSON.stringify(task.last_failed_export)}`);
  if (task.last_known_error) lines.push(`- 匹配该任务的最近错误：${task.last_known_error.code} · ${task.last_known_error.message}`);
  return lines;
}

/** AI 错误调试信息报告体（不脱敏）：完整快照 + OCR 上下文 + 最近日志。 */
export interface AiDebugOcrContext {
  status: "included" | "not_available";
  occurrence?: Record<string, unknown>;
  layout_context?: unknown;
  error?: string;
}

export function buildAiDebugReport(
  snapshot: DeveloperSnapshot,
  ocrContext: AiDebugOcrContext,
  logLines: string[],
  logCollectionErrors: Array<{ section: string; message: string }>,
): string {
  const sections: string[] = [
    "# ArchiveLens AI 错误调试信息（未脱敏）",
    `生成时间：${snapshot.generated_at}`,
    "此内容包含用户名、完整路径、文件名、OCR 正文、原始错误、调用栈和最近日志。仅写入本机剪贴板，不会自动发送。",
    "",
    "## 完整诊断快照（JSON）",
    "```json",
    JSON.stringify(snapshot, null, 2),
    "```",
    "",
    "## 当前 OCR 上下文",
  ];
  if (ocrContext.status === "not_available") {
    sections.push(`ocr_context_status: not_available${ocrContext.error ? `（${ocrContext.error}）` : ""}`);
  } else {
    sections.push("```json", JSON.stringify({ occurrence: ocrContext.occurrence ?? null, layout_context: ocrContext.layout_context ?? null }, null, 2), "```");
  }
  sections.push("", `## 最近日志（合并、时间排序，最多 ${MAX_AI_DEBUG_LOG_LINES} 行）`);
  if (logCollectionErrors.length > 0) {
    sections.push(...logCollectionErrors.map((entry) => `[日志读取错误] ${entry.section}：${entry.message}`));
  }
  sections.push("```log", logLines.join("\n"), "```");
  return sections.join("\n");
}

// --------------------------------------------------------------------------- //
// 日志尾部读取（仅供 AI 调试复制；开发者快照与原始 JSON 不含日志正文）
// --------------------------------------------------------------------------- //

const LOG_FILES_IN_ORDER = ["app.log.1", "engine.log.1", "app.log", "engine.log"] as const;

interface OrderedLogLine {
  timestampMs: number;
  fileOrder: number;
  lineIndex: number;
  text: string;
}

/** 读取并合并四个日志文件的最近若干行；不脱敏、保留整行；缺失或不可读只记入 errors。 */
export async function readLogTail(
  logDir: string,
  maxLines = MAX_AI_DEBUG_LOG_LINES,
): Promise<{ lines: string[]; errors: Array<{ section: string; message: string }> }> {
  const errors: Array<{ section: string; message: string }> = [];
  const ordered: OrderedLogLine[] = [];

  for (let fileOrder = 0; fileOrder < LOG_FILES_IN_ORDER.length; fileOrder += 1) {
    const fileName = LOG_FILES_IN_ORDER[fileOrder]!;
    let content: string;
    try {
      content = await readFile(join(logDir, fileName), "utf-8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        errors.push({ section: fileName, message: error instanceof Error ? error.message : String(error) });
      }
      continue;
    }
    const rawLines = content.split("\n").filter((line) => line.length > 0);
    let lastTimestampMs = 0;
    rawLines.forEach((text, lineIndex) => {
      const match = /^\[([^\]]+)\]/.exec(text);
      const parsed = match ? Date.parse(match[1]!) : Number.NaN;
      const timestampMs = Number.isNaN(parsed) ? lastTimestampMs : parsed;
      if (!Number.isNaN(parsed)) lastTimestampMs = parsed;
      ordered.push({ timestampMs, fileOrder, lineIndex, text });
    });
  }

  ordered.sort((left, right) =>
    left.timestampMs - right.timestampMs
    || left.fileOrder - right.fileOrder
    || left.lineIndex - right.lineIndex);

  const lines = ordered.slice(-maxLines).map((entry) => entry.text);
  return { lines, errors };
}
