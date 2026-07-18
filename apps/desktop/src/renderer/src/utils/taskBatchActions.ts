import type { TaskSummary } from "../../../preload/api";


export type BatchTaskAction = "pause" | "cancel" | "delete";

export type BatchEligibility = {
  executable: boolean;
  label: string;
  reason: string;
};

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);


export function batchActionLabel(action: BatchTaskAction): string {
  if (action === "pause") return "暂停";
  if (action === "cancel") return "取消";
  return "删除";
}


export function batchEligibility(
  task: Pick<TaskSummary, "status" | "cleanup_status">,
  action: BatchTaskAction,
): BatchEligibility {
  if (action === "delete") {
    if (task.cleanup_status === "cleanup_failed") {
      return { executable: true, label: "重试清理", reason: "此前清理失败，将重试任务派生数据清理" };
    }
    if (task.cleanup_status) {
      return { executable: false, label: "跳过", reason: "任务删除流程正在进行" };
    }
    if (TERMINAL_STATUSES.has(task.status)) {
      return { executable: true, label: "删除任务", reason: "任务已结束，可以安全删除本地派生数据" };
    }
    return { executable: false, label: "跳过", reason: "运行中的任务必须先取消并进入终态" };
  }

  if (task.cleanup_status) {
    return { executable: false, label: "跳过", reason: "任务正在删除或等待重试清理" };
  }
  if (action === "pause") {
    return task.status === "running"
      ? { executable: true, label: "暂停任务", reason: "任务正在扫描" }
      : { executable: false, label: "跳过", reason: "只有扫描中的任务可以暂停" };
  }
  if (TERMINAL_STATUSES.has(task.status)) {
    return { executable: false, label: "跳过", reason: "任务已经结束" };
  }
  if (task.status === "stopping") {
    return { executable: false, label: "跳过", reason: "任务已经在取消中" };
  }
  return { executable: true, label: "取消任务", reason: "任务尚未结束" };
}


export function batchPreview(
  tasks: Array<Pick<TaskSummary, "status" | "cleanup_status">>,
  action: BatchTaskAction,
): { executable: number; skipped: number } {
  const executable = tasks.filter((task) => batchEligibility(task, action).executable).length;
  return { executable, skipped: tasks.length - executable };
}
