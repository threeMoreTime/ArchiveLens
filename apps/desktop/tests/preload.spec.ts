import { describe, it, expect, vi, beforeAll } from "vitest";

// 用 mock electron 捕获 contextBridge 暴露的 API，无需真实 Electron 运行时。
const exposed: Record<string, unknown> = {};
vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: unknown) => Object.assign(exposed, api as object),
  },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), off: vi.fn() },
}));

beforeAll(async () => {
  await import("../src/preload/index");
});

describe("Preload API 形状（任务 §五.3）", () => {
  it("暴露允许的命名空间", () => {
    for (const k of ["app", "dialog", "subscribe", "tasks", "demo", "results", "review", "export", "files"]) {
      expect(exposed[k]).toBeDefined();
    }
  });

  it("不暴露 ipcRenderer / fs / child_process / require", () => {
    for (const k of ["ipcRenderer", "fs", "child_process", "require", "spawn", "exec", "process"]) {
      expect(exposed[k]).toBeUndefined();
    }
  });

  it("subscribe.onEvent 返回 unsubscribe 函数", () => {
    const subscribe = exposed.subscribe as { onEvent: (cb: (e: unknown) => void) => unknown };
    const off = subscribe.onEvent(() => undefined);
    expect(typeof off).toBe("function");
  });
});
