import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLifecycleController, type CloseAction } from "../src/main/lifecycle/controller";

function createHarness() {
  const hide = vi.fn();
  const show = vi.fn();
  const focus = vi.fn();
  const isVisible = vi.fn(() => true);
  const sidecar = {
    isReady: true,
    call: vi.fn(),
    stop: vi.fn(async () => undefined),
  };
  const appControl = {
    exit: vi.fn(),
    quit: vi.fn(),
  };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const waitForTaskEvent = vi.fn(async () => false);

  const controller = createLifecycleController({
    sidecar,
    logger,
    getMainWindow: () => ({
      hide,
      show,
      focus,
      isVisible,
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    }),
    destroyTray: vi.fn(),
    appControl,
    timeoutMs: 500,
    waitForTaskEvent,
    findActiveTask: vi.fn(async () => ({
      task_id: "task-1",
      status: "running",
      processed_pages: 3,
      total_pages: 20,
    })),
  });

  return { controller, hide, show, focus, isVisible, sidecar, appControl, logger, waitForTaskEvent };
}

describe("LifecycleController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("minimize keeps task running and hides the main window", async () => {
    const { controller, hide, sidecar, appControl } = createHarness();

    const prompt = await controller.requestClose();
    expect(prompt.requiresAction).toBe(true);

    const result = await controller.selectCloseAction("minimize");

    expect(result.outcome).toBe("minimized");
    expect(hide).toHaveBeenCalledTimes(1);
    expect(sidecar.call).not.toHaveBeenCalledWith("tasks.pause", expect.anything());
    expect(sidecar.stop).not.toHaveBeenCalled();
    expect(appControl.exit).not.toHaveBeenCalled();
    expect(controller.getState().shutdownFlowRunning).toBe(false);
  });

  it("cancel clears shutdown flow and allows a second close request", async () => {
    const { controller, sidecar, appControl } = createHarness();

    await controller.requestClose();
    const cancelled = await controller.selectCloseAction("cancel");
    expect(cancelled.outcome).toBe("cancelled");
    expect(sidecar.call).not.toHaveBeenCalledWith("tasks.pause", expect.anything());
    expect(sidecar.call).not.toHaveBeenCalledWith("tasks.cancel", expect.anything());
    expect(appControl.exit).not.toHaveBeenCalled();
    expect(controller.getState().shutdownFlowRunning).toBe(false);

    const second = await controller.requestClose();
    expect(second.requiresAction).toBe(true);
    expect(controller.getState().shutdownFlowRunning).toBe(true);
  });

  it("pause timeout enters waiting state and continue_waiting does not duplicate pause", async () => {
    const { controller, sidecar } = createHarness();
    sidecar.call.mockImplementation(async (method: string) => {
      if (method === "tasks.pause") return { task_id: "task-1", status: "pausing" };
      if (method === "tasks.get") return { task_id: "task-1", status: "running" };
      return {};
    });

    await controller.requestClose();
    const timedOut = await controller.selectCloseAction("pause_and_quit");
    expect(timedOut.outcome).toBe("timed_out");
    expect(controller.getState().awaitingTimeoutResolution).toBe(true);
    expect(sidecar.call).toHaveBeenCalledTimes(2);
    expect(sidecar.call).toHaveBeenCalledWith("tasks.pause", { task_id: "task-1" }, 5_000);

    const resumeWait = await controller.selectCloseAction("continue_waiting");
    expect(resumeWait.outcome).toBe("timed_out");
    expect(sidecar.call).toHaveBeenCalledTimes(3);
    expect(sidecar.call.mock.calls.filter(([method]) => method === "tasks.pause")).toHaveLength(1);
  });

  it("pause and quit accepts a task that completes before paused is emitted", async () => {
    const { controller, sidecar, appControl, waitForTaskEvent } = createHarness();
    sidecar.call.mockImplementation(async (method: string) => {
      if (method === "tasks.pause") return { task_id: "task-1", status: "pausing" };
      if (method === "tasks.get") return { task_id: "task-1", status: "completed" };
      return {};
    });

    await controller.requestClose();
    const result = await controller.selectCloseAction("pause_and_quit");

    expect(result.outcome).toBe("quit");
    expect(waitForTaskEvent).toHaveBeenCalledWith(
      ["task.paused", "task.completed", "task.failed", "task.cancelled"],
      "task-1",
      500,
    );
    expect(sidecar.stop).toHaveBeenCalledTimes(1);
    expect(appControl.exit).toHaveBeenCalledWith(0);
  });

  it("force quit after timeout stops the sidecar and exits the app", async () => {
    const { controller, sidecar, appControl } = createHarness();
    sidecar.call.mockImplementation(async (method: string) => {
      if (method === "tasks.pause") return { task_id: "task-1", status: "pausing" };
      if (method === "tasks.get") return { task_id: "task-1", status: "running" };
      return {};
    });

    await controller.requestClose();
    await controller.selectCloseAction("pause_and_quit");
    const forced = await controller.selectCloseAction("force_quit");

    expect(forced.outcome).toBe("quit");
    expect(sidecar.stop).toHaveBeenCalledTimes(1);
    expect(appControl.exit).toHaveBeenCalledWith(0);
    expect(controller.getState().lastAction).toBe("force_quit" satisfies CloseAction);
  });

  it("continue_waiting exits once paused is observed without re-sending pause", async () => {
    const { controller, sidecar, appControl } = createHarness();
    let getCalls = 0;
    sidecar.call.mockImplementation(async (method: string) => {
      if (method === "tasks.pause") return { task_id: "task-1", status: "pausing" };
      if (method === "tasks.get") {
        getCalls += 1;
        return { task_id: "task-1", status: getCalls === 1 ? "running" : "paused" };
      }
      return {};
    });

    await controller.requestClose();
    const timedOut = await controller.selectCloseAction("pause_and_quit");
    expect(timedOut.outcome).toBe("timed_out");

    const continued = await controller.selectCloseAction("continue_waiting");
    expect(continued.outcome).toBe("quit");
    expect(sidecar.call).toHaveBeenCalledWith("tasks.pause", { task_id: "task-1" }, 5_000);
    expect(sidecar.stop).toHaveBeenCalledTimes(1);
    expect(appControl.exit).toHaveBeenCalledWith(0);
  });

  it("cancel after timeout resumes the task before clearing the shutdown flow", async () => {
    const { controller, sidecar } = createHarness();
    let getCalls = 0;
    sidecar.call.mockImplementation(async (method: string) => {
      if (method === "tasks.pause") return { task_id: "task-1", status: "pausing" };
      if (method === "tasks.get") {
        getCalls += 1;
        const status = getCalls === 1 ? "running" : getCalls === 2 ? "pausing" : "paused";
        return { task_id: "task-1", status };
      }
      if (method === "tasks.resume") return { task_id: "task-1", status: "running" };
      return {};
    });

    await controller.requestClose();
    await controller.selectCloseAction("pause_and_quit");
    const cancelled = await controller.selectCloseAction("cancel");

    expect(cancelled.outcome).toBe("cancelled");
    expect(sidecar.call).toHaveBeenCalledWith("tasks.get", { task_id: "task-1" }, 5_000);
    expect(sidecar.call).toHaveBeenCalledWith("tasks.resume", { task_id: "task-1" }, 5_000);
    expect(controller.getState().shutdownFlowRunning).toBe(false);
    expect(controller.getState().awaitingTimeoutResolution).toBe(false);
  });

  it("stop_and_quit falls back to persisted cancelled status when the event wait times out", async () => {
    const { controller, sidecar, appControl } = createHarness();
    sidecar.call.mockImplementation(async (method: string) => {
      if (method === "tasks.cancel") return { task_id: "task-1", status: "stopping" };
      if (method === "tasks.get") return { task_id: "task-1", status: "cancelled" };
      return {};
    });

    await controller.requestClose();
    const stopped = await controller.selectCloseAction("stop_and_quit");

    expect(stopped.outcome).toBe("quit");
    expect(sidecar.call).toHaveBeenCalledWith("tasks.cancel", { task_id: "task-1" }, 5_000);
    expect(appControl.exit).toHaveBeenCalledWith(0);
  });
});
