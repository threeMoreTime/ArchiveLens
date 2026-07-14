export type CloseAction =
  | "minimize"
  | "cancel"
  | "pause_and_quit"
  | "stop_and_quit"
  | "continue_waiting"
  | "force_quit";

export interface ActiveTaskSummary {
  task_id: string;
  status: string;
  processed_pages?: number;
  total_pages?: number;
}

interface WindowLike {
  hide(): void;
  show(): void;
  focus(): void;
  isVisible?(): boolean;
  isDestroyed?(): boolean;
  webContents?: { send: (channel: string, payload: unknown) => void };
}

interface SidecarLike {
  isReady: boolean;
  call<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  stop(reason?: "app_shutdown" | "forced_shutdown"): Promise<void>;
}

interface LoggerLike {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

interface AppControlLike {
  exit(code: number): void;
  quit?(): void;
}

export interface LifecycleState {
  shutdownFlowRunning: boolean;
  awaitingTimeoutResolution: boolean;
  approvedQuit: boolean;
  activeTaskId: string | null;
  lastAction: CloseAction | null;
}

export interface CloseRequestResult {
  requiresAction: boolean;
  activeTask: ActiveTaskSummary | null;
}

export interface CloseSelectionResult {
  outcome: "minimized" | "cancelled" | "quit" | "timed_out" | "waiting" | "noop";
}

export interface LifecycleControllerDeps {
  sidecar: SidecarLike;
  logger: LoggerLike;
  getMainWindow: () => WindowLike | null;
  destroyTray: () => void;
  appControl: AppControlLike;
  timeoutMs: number;
  waitForTaskEvent: (eventNames: readonly string[], taskId: string, timeoutMs: number) => Promise<boolean>;
  findActiveTask: () => Promise<ActiveTaskSummary | null>;
}

export interface LifecycleController {
  requestClose(): Promise<CloseRequestResult>;
  selectCloseAction(action: CloseAction): Promise<CloseSelectionResult>;
  getState(): LifecycleState;
  approveNativeQuit(): void;
  reset(): void;
}

// The close-flow timeout controls how long we wait for a state transition, not
// how long the sidecar gets to acknowledge a control command on a busy runner.
const CONTROL_REQUEST_TIMEOUT_FLOOR_MS = 5_000;
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled"]);
const TERMINAL_TASK_EVENTS = ["task.completed", "task.failed", "task.cancelled"] as const;

function initialState(): LifecycleState {
  return {
    shutdownFlowRunning: false,
    awaitingTimeoutResolution: false,
    approvedQuit: false,
    activeTaskId: null,
    lastAction: null,
  };
}

export function createLifecycleController(deps: LifecycleControllerDeps): LifecycleController {
  const state = initialState();
  const controlRequestTimeoutMs = Math.max(deps.timeoutMs, CONTROL_REQUEST_TIMEOUT_FLOOR_MS);

  async function getTaskStatus(taskId: string): Promise<string | null> {
    try {
      const task = await deps.sidecar.call<{ status?: unknown }>("tasks.get", { task_id: taskId }, controlRequestTimeoutMs);
      return typeof task?.status === "string" ? task.status : null;
    } catch {
      return null;
    }
  }

  async function waitForPausedState(taskId: string): Promise<boolean> {
    return waitForTaskState(taskId, "task.paused", "paused");
  }

  async function waitForTaskState(taskId: string, eventName: string, expectedStatus: string): Promise<boolean> {
    const terminalStateAlsoFinishesTransition = expectedStatus === "paused" || expectedStatus === "cancelled";
    const acceptedEvents = terminalStateAlsoFinishesTransition
      ? [eventName, ...TERMINAL_TASK_EVENTS]
      : [eventName];
    const observed = await deps.waitForTaskEvent(acceptedEvents, taskId, deps.timeoutMs);
    if (observed) {
      return true;
    }
    const status = await getTaskStatus(taskId);
    return status === expectedStatus || (terminalStateAlsoFinishesTransition && status !== null && TERMINAL_TASK_STATUSES.has(status));
  }

  async function performQuit(reason: "app_shutdown" | "forced_shutdown" = "app_shutdown"): Promise<CloseSelectionResult> {
    state.approvedQuit = true;
    deps.logger.info("生命周期关闭：停止 Sidecar 并退出应用");
    try {
      await deps.sidecar.stop(reason);
    } catch (error) {
      deps.logger.warn(`停止 Sidecar 时出现异常：${String(error)}`);
    }
    deps.destroyTray();
    deps.appControl.exit(0);
    state.shutdownFlowRunning = false;
    state.awaitingTimeoutResolution = false;
    return { outcome: "quit" };
  }

  function clearFlow(lastAction: CloseAction | null): void {
    state.shutdownFlowRunning = false;
    state.awaitingTimeoutResolution = false;
    state.activeTaskId = null;
    state.lastAction = lastAction;
  }

  return {
    async requestClose(): Promise<CloseRequestResult> {
      if (state.shutdownFlowRunning) {
        return {
          requiresAction: state.activeTaskId !== null,
          activeTask: state.activeTaskId ? { task_id: state.activeTaskId, status: "running" } : null,
        };
      }

      state.shutdownFlowRunning = true;
      const activeTask = await deps.findActiveTask();
      state.activeTaskId = activeTask?.task_id ?? null;

      if (!activeTask) {
        return performQuit().then(() => ({ requiresAction: false, activeTask: null }));
      }

      deps.logger.info(`生命周期关闭请求：task=${activeTask.task_id}`);
      return { requiresAction: true, activeTask };
    },

    async selectCloseAction(action: CloseAction): Promise<CloseSelectionResult> {
      state.lastAction = action;
      const taskId = state.activeTaskId;

      if (!state.shutdownFlowRunning) {
        return { outcome: "noop" };
      }

      if (action === "minimize") {
        const win = deps.getMainWindow();
        if (win && !win.isDestroyed?.()) {
          win.hide();
          deps.logger.info(`生命周期动作 minimize：窗口已隐藏 visible=${win.isVisible?.() ?? "unknown"}`);
        } else {
          deps.logger.warn("生命周期动作 minimize：主窗口不可用");
        }
        clearFlow(action);
        return { outcome: "minimized" };
      }

      if (action === "cancel") {
        if (state.awaitingTimeoutResolution && taskId) {
          const status = await getTaskStatus(taskId);
          if (status !== null && status !== "running" && status !== "completed" && status !== "cancelled") {
            try {
              await deps.sidecar.call("tasks.resume", { task_id: taskId }, controlRequestTimeoutMs);
            } catch (error) {
              deps.logger.warn(`生命周期动作 cancel：恢复任务失败 task=${taskId} error=${String(error)}`);
            }
          }
        }
        deps.logger.info("生命周期动作 cancel：关闭流程已重置");
        clearFlow(action);
        return { outcome: "cancelled" };
      }

      if (action === "continue_waiting") {
        if (state.awaitingTimeoutResolution) {
          deps.logger.info(`生命周期动作 continue_waiting：继续等待 task=${taskId ?? "none"}`);
          if (!taskId) {
            return { outcome: "waiting" };
          }
          const paused = await waitForPausedState(taskId);
          if (!paused) {
            deps.logger.warn(`生命周期动作 continue_waiting：等待 paused 仍超时 task=${taskId}`);
            return { outcome: "timed_out" };
          }
          return performQuit();
        }
        return { outcome: "noop" };
      }

      if (action === "force_quit") {
        deps.logger.warn(`生命周期动作 force_quit：task=${taskId ?? "none"}`);
        return performQuit("forced_shutdown");
      }

      if (!taskId) {
        return performQuit();
      }

      if (action === "pause_and_quit") {
        deps.logger.info(`生命周期动作 pause_and_quit：task=${taskId}`);
        await deps.sidecar.call("tasks.pause", { task_id: taskId }, controlRequestTimeoutMs);
        const paused = await waitForPausedState(taskId);
        if (!paused) {
          state.awaitingTimeoutResolution = true;
          deps.logger.warn(`生命周期关闭超时：task.paused 未在 ${deps.timeoutMs}ms 内到达（task=${taskId}）`);
          return { outcome: "timed_out" };
        }
        return performQuit();
      }

      if (action === "stop_and_quit") {
        deps.logger.info(`生命周期动作 stop_and_quit：task=${taskId}`);
        await deps.sidecar.call("tasks.cancel", { task_id: taskId }, controlRequestTimeoutMs);
        await waitForTaskState(taskId, "task.cancelled", "cancelled");
        return performQuit();
      }

      return { outcome: "noop" };
    },

    getState(): LifecycleState {
      return { ...state };
    },

    approveNativeQuit(): void {
      state.approvedQuit = true;
    },

    reset(): void {
      const next = initialState();
      state.shutdownFlowRunning = next.shutdownFlowRunning;
      state.awaitingTimeoutResolution = next.awaitingTimeoutResolution;
      state.approvedQuit = next.approvedQuit;
      state.activeTaskId = next.activeTaskId;
      state.lastAction = next.lastAction;
    },
  };
}
