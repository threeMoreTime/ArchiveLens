import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  return {
    handlers,
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => handlers.set(channel, handler)),
    openPath: vi.fn(),
  };
});

vi.mock("electron", () => ({
  ipcMain: { handle: mocks.handle },
  shell: { openPath: mocks.openPath },
}));
vi.mock("../src/main/ipc/settings", () => ({
  getSettingsStore: () => ({ removeTaskOverride: vi.fn() }),
}));

import {
  HTML_EXPORT_TIMEOUT_MS,
  registerEngineHandlers,
} from "../src/main/ipc/engine";

describe("engine IPC timeouts", () => {
  it("allows a large HTML export to outlive the generic 30 second request timeout", async () => {
    const call = vi.fn().mockResolvedValue({ path: "report.html" });
    registerEngineHandlers({ call } as any);
    const handler = mocks.handlers.get("export.html");
    expect(handler).toBeDefined();

    const params = { task_id: "task-1" };
    await handler?.({}, params);

    expect(HTML_EXPORT_TIMEOUT_MS).toBe(30 * 60_000);
    expect(call).toHaveBeenCalledWith("export.html", params, HTML_EXPORT_TIMEOUT_MS);
  });
});

describe("tasks.openCleanupDir 受控打开残留目录", () => {
  it("经 engine tasks.cleanupTarget 推导路径，再用 shell.openPath 打开；renderer 仅传 task_id", async () => {
    const call = vi.fn().mockResolvedValue({ task_id: "task-1", path: "E:\\residual" });
    mocks.openPath.mockResolvedValue("");
    registerEngineHandlers({ call } as any);
    const handler = mocks.handlers.get("tasks.openCleanupDir");
    expect(handler).toBeDefined();

    const result = await handler?.({}, { task_id: "task-1" });

    expect(call).toHaveBeenCalledWith("tasks.cleanupTarget", { task_id: "task-1" });
    expect(mocks.openPath).toHaveBeenCalledWith("E:\\residual");
    expect(result).toEqual({ ok: true });
  });

  it("engine 返回 null 路径时拒绝打开", async () => {
    mocks.openPath.mockClear();
    const call = vi.fn().mockResolvedValue({ task_id: "task-1", path: null });
    registerEngineHandlers({ call } as any);
    const handler = mocks.handlers.get("tasks.openCleanupDir");
    await expect(handler?.({}, { task_id: "task-1" })).rejects.toThrow();
    expect(mocks.openPath).not.toHaveBeenCalled();
  });
});
