import { create } from "zustand";

/**
 * 任务事件 store（任务 §五.2）。
 *
 * 关键不变量：
 *  - ``applyEvent`` 按 ``sequence`` 单调推进，旧 sequence 不覆盖新状态；
 *  - 终态（completed/failed/cancelled）不被旧 task.progress 改回 running。
 *
 * 当前 Renderer 部分页面仍用本地 state；该 store 提供权威事件归并，供后续
 * 完整接入。逻辑独立可测。
 */

export type TaskStatus =
  | "draft"
  | "queued"
  | "starting"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "recoverable"
  | "stale"
  | "unknown";

export interface TrackedTask {
  task_id: string;
  status: TaskStatus;
  processed_pages?: number;
  total_pages?: number;
  occurrence_count?: number;
  last_error?: string | null;
}

export interface EngineEvent {
  event: string;
  task_id?: string | null;
  sequence?: number;
  payload?: Record<string, unknown>;
}

const TERMINAL: TaskStatus[] = ["completed", "failed", "cancelled"];

interface TaskStoreState {
  tasks: Record<string, TrackedTask>;
  lastSequence: Record<string, number>;
  applyEvent: (event: EngineEvent) => void;
  reset: () => void;
}

function reduceTask(prev: TrackedTask | undefined, tid: string, event: EngineEvent): TrackedTask {
  const next: TrackedTask = { ...(prev ?? { task_id: tid, status: "unknown" }) };
  const payload = event.payload ?? {};
  switch (event.event) {
    case "task.created":
      next.status = prev?.status === "unknown" ? "draft" : prev?.status ?? "draft";
      break;
    case "task.started":
    case "task.resumed":
      if (!prev || !TERMINAL.includes(prev.status)) next.status = "running";
      break;
    case "task.progress":
      // 终态保护：completed/failed/cancelled 不被 progress 改回
      if (!prev || !TERMINAL.includes(prev.status)) {
        next.status = "running";
        if (typeof payload.processed_pages === "number")
          next.processed_pages = payload.processed_pages;
        if (typeof payload.total_pages === "number") next.total_pages = payload.total_pages;
      }
      break;
    case "task.paused":
      if (!prev || !TERMINAL.includes(prev.status)) next.status = "paused";
      break;
    case "task.completed":
      next.status = "completed";
      if (typeof payload.occurrence_count === "number")
        next.occurrence_count = payload.occurrence_count;
      break;
    case "task.failed":
      next.status = "failed";
      next.last_error = typeof payload.error === "string" ? payload.error : null;
      break;
    case "task.cancelled":
      next.status = "cancelled";
      break;
    default:
      break;
  }
  return next;
}

export const useTaskStore = create<TaskStoreState>((set, get) => ({
  tasks: {},
  lastSequence: {},
  applyEvent: (event) => {
    const tid = event.task_id;
    if (!tid) return;
    const seq = typeof event.sequence === "number" ? event.sequence : 0;
    const last = get().lastSequence[tid] ?? 0;
    // 旧 sequence 不得覆盖新状态（防乱序）
    if (seq <= last) return;
    set((s) => ({
      lastSequence: { ...s.lastSequence, [tid]: Math.max(last, seq) },
      tasks: { ...s.tasks, [tid]: reduceTask(s.tasks[tid], tid, event) },
    }));
  },
  reset: () => set({ tasks: {}, lastSequence: {} }),
}));
