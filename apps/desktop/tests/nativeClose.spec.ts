import { describe, expect, it, vi } from "vitest";
import { installNativeCloseHandler } from "../src/main/lifecycle/nativeClose";

function createHarness(options: { approvedQuit?: boolean; shutdownFlowRunning?: boolean } = {}) {
  let listener: ((event: { preventDefault(): void }) => void) | undefined;
  const lifecycle = {
    getState: vi.fn(() => ({
      approvedQuit: options.approvedQuit ?? false,
      shutdownFlowRunning: options.shutdownFlowRunning ?? false,
    })),
    requestClose: vi.fn(async () => ({
      requiresAction: true,
      activeTask: { task_id: "task-1", status: "running" },
    })),
    selectCloseAction: vi.fn(async () => ({ outcome: "minimized" })),
    reset: vi.fn(),
  };
  const prompt = vi.fn(async () => "minimize" as const);
  const logger = { info: vi.fn(), error: vi.fn() };
  installNativeCloseHandler({
    win: {
      on: (_event, next) => {
        listener = next;
      },
    },
    lifecycle,
    prompt,
    logger,
  });
  return {
    lifecycle,
    prompt,
    logger,
    close: async () => {
      const preventDefault = vi.fn();
      listener?.({ preventDefault });
      await vi.waitFor(() =>
        expect(lifecycle.requestClose).toHaveBeenCalledTimes(
          options.approvedQuit || options.shutdownFlowRunning ? 0 : 1,
        ),
      );
      return preventDefault;
    },
  };
}

describe("native window close lifecycle", () => {
  it("keeps the main window alive until the native decision is selected", async () => {
    const harness = createHarness();
    const preventDefault = await harness.close();

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(harness.prompt).toHaveBeenCalledTimes(1);
    expect(harness.lifecycle.selectCloseAction).toHaveBeenCalledWith("minimize");
  });

  it("does not intercept an approved quit", async () => {
    const harness = createHarness({ approvedQuit: true });
    const preventDefault = await harness.close();

    expect(preventDefault).not.toHaveBeenCalled();
    expect(harness.prompt).not.toHaveBeenCalled();
  });

  it("keeps intercepting close without opening a duplicate decision while a flow is active", async () => {
    const harness = createHarness({ shutdownFlowRunning: true });
    const preventDefault = await harness.close();

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(harness.prompt).not.toHaveBeenCalled();
  });
});
