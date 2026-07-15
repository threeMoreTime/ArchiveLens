import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  return {
    handlers,
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => handlers.set(channel, handler)),
  };
});

vi.mock("electron", () => ({
  ipcMain: { handle: mocks.handle },
  shell: { openPath: vi.fn() },
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
