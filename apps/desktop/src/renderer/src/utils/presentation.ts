import type { TaskSummary } from "../../../preload/api";

export type BadgeTone = "PASS" | "WARN" | "FAIL";

export function sourceBaseName(sourcePath: string): string {
  const normalized = sourcePath.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

export function buildTaskName(sourceDir: string, searchText: string): string {
  const source = sourceBaseName(sourceDir) || "本地档案";
  return `${source} · 检索“${searchText}”`;
}

export function taskDisplayName(task: Pick<TaskSummary, "name" | "source_dir" | "search_text">): string {
  const rawName = task.name?.trim();
  const source = sourceBaseName(task.source_dir);
  if (rawName && rawName !== source) return rawName;
  if (task.search_text) return buildTaskName(task.source_dir, task.search_text);
  return rawName || source || "扫描任务";
}

export function taskSourceLabel(task: Pick<TaskSummary, "source_dir" | "source_label">): string {
  return task.source_label?.trim() || task.source_dir || "未提供来源";
}

export function taskStatusView(
  task: Pick<TaskSummary, "status" | "failure_count">,
): { label: string; tone: BadgeTone } {
  if (task.status === "completed" && task.failure_count > 0) {
    return { label: `部分完成（${task.failure_count} 项失败）`, tone: "WARN" };
  }
  const labels: Record<string, string> = {
    draft: "待启动",
    queued: "排队中",
    starting: "正在启动",
    running: "扫描中",
    pausing: "正在暂停",
    paused: "已暂停",
    resuming: "正在恢复",
    stopping: "正在取消",
    recoverable: "可恢复",
    stale: "状态异常",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };
  const tone: BadgeTone = task.status === "completed"
    ? "PASS"
    : ["failed", "cancelled", "stale"].includes(task.status)
      ? "FAIL"
      : "WARN";
  return { label: (labels[task.status] ?? task.status) || "状态未知", tone };
}

/** 任务删除生命周期视图（独立于 OCR 运行 status）。无 cleanup 状态时返回 null。 */
export function cleanupStatusView(
  cleanup_status?: string | null,
): { label: string; tone: BadgeTone } | null {
  if (cleanup_status === "pending") return { label: "正在删除", tone: "WARN" };
  if (cleanup_status === "cleanup_failed") return { label: "清理失败", tone: "FAIL" };
  return null;
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(parsed);
}

export function diagnosticStatusLabel(status: string): string {
  if (status === "PASS") return "可用";
  if (status === "WARN") return "受限";
  if (status === "FAIL") return "不可用";
  return "状态未知";
}
