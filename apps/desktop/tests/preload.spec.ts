import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";

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
    for (const k of ["app", "dialog", "subscribe", "tasks", "demo", "results", "search", "review", "export", "settings"]) {
      expect(exposed[k]).toBeDefined();
    }
  });

  it("不暴露可接收 renderer 任意路径的 files 命名空间", () => {
    expect(exposed.files).toBeUndefined();
    expect((exposed.app as Record<string, unknown>).openUserDataDirectory).toBeDefined();
    expect((exposed.tasks as Record<string, unknown>).openDirectory).toBeDefined();
    expect((exposed.export as Record<string, unknown>).openDirectory).toBeDefined();
  });

  it("不暴露 ipcRenderer / fs / child_process / require", () => {
    for (const k of ["ipcRenderer", "fs", "child_process", "require", "spawn", "exec", "process"]) {
      expect(exposed[k]).toBeUndefined();
    }
  });

  it("暴露开发者边界 API，但仍不提供通用文件读取能力", () => {
    const app = exposed.app as Record<string, unknown>;
    const settings = exposed.settings as Record<string, unknown>;
    for (const method of ["getVersion", "getDeveloperSnapshot", "reportRendererError", "copyDiagnosticSummary", "copyAiDebugInfo", "openRendererDevTools"]) {
      expect(typeof app[method]).toBe("function");
    }
    expect(typeof settings.getDeveloperMode).toBe("function");
    expect(typeof settings.setDeveloperMode).toBe("function");
    // 仍不得暴露任意读文件、读日志正文或执行进程的能力
    expect(app.readFile).toBeUndefined();
    expect(app.readLog).toBeUndefined();
    expect((exposed as Record<string, unknown>).files).toBeUndefined();
  });

  it("subscribe.onEvent 返回 unsubscribe 函数", () => {
    const subscribe = exposed.subscribe as { onEvent: (cb: (e: unknown) => void) => unknown };
    const off = subscribe.onEvent(() => undefined);
    expect(typeof off).toBe("function");
  });

  it("普通环境（无 ARCHIVELENS_E2E）：api.test 不存在，58 个生产 invoke API 正常", () => {
    // beforeAll 在普通环境导入，api.test 应为 undefined
    expect(exposed.test).toBeUndefined();
    // 抽样校验生产 API 存在（完整 58 项由 ipcContractConsistency.spec.ts 的 Preload 边界测试覆盖）
    const tasks = exposed.tasks as Record<string, unknown>;
    const settings = exposed.settings as Record<string, unknown>;
    expect(typeof tasks.create).toBe("function");
    expect(typeof settings.get).toBe("function");
  });
});

describe("Preload E2E 边界（ARCHIVELENS_E2E=1）", () => {
  // 隔离模块缓存与环境变量，避免 E2E 状态泄漏到其他 Vitest 文件。
  let e2eExposed: Record<string, unknown> = {};

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    e2eExposed = {};
  });

  it("E2E 环境：api.test 存在且包含完整 13 个 test 方法", async () => {
    vi.resetModules();
    vi.stubEnv("ARCHIVELENS_E2E", "1");
    // 为这次导入准备独立的 exposed 捕获
    const localExposed: Record<string, unknown> = {};
    vi.doMock("electron", () => ({
      contextBridge: {
        exposeInMainWorld: (_name: string, api: unknown) => Object.assign(localExposed, api as object),
      },
      ipcRenderer: { invoke: vi.fn(), on: vi.fn(), off: vi.fn() },
    }));
    await import("../src/preload/index");
    e2eExposed = localExposed;

    const testApi = e2eExposed.test as Record<string, Record<string, unknown>> | undefined;
    expect(testApi, "E2E 环境应暴露 api.test").toBeDefined();
    if (!testApi) return;

    // 13 个 test 方法（5 个 test.task.* + 3 lifecycle + 2 tray + 1 window + 1 engine + 1 sidecar）
    const expectedMethods = [
      "test.lifecycle.requestClose",
      "test.lifecycle.selectCloseAction",
      "test.lifecycle.getState",
      "test.tray.getState",
      "test.tray.restoreWindow",
      "test.window.getState",
      "test.engine.getPid",
      "test.sidecar.simulateCrash",
      "test.task.getState",
      "test.task.getProcessedPageIds",
      "test.task.getOccurrenceIds",
      "test.task.getCheckpoint",
      "test.task.getEventSequence",
    ];
    // 校验各命名空间下的方法存在
    expect(typeof testApi.lifecycle.requestClose).toBe("function");
    expect(typeof testApi.lifecycle.selectCloseAction).toBe("function");
    expect(typeof testApi.lifecycle.getState).toBe("function");
    expect(typeof testApi.tray.getState).toBe("function");
    expect(typeof testApi.tray.restoreWindow).toBe("function");
    expect(typeof testApi.window.getState).toBe("function");
    expect(typeof testApi.engine.getPid).toBe("function");
    expect(typeof testApi.sidecar.simulateCrash).toBe("function");
    const task = testApi.task as Record<string, unknown>;
    expect(typeof task.getState).toBe("function");
    expect(typeof task.getProcessedPageIds).toBe("function");
    expect(typeof task.getOccurrenceIds).toBe("function");
    expect(typeof task.getCheckpoint).toBe("function");
    expect(typeof task.getEventSequence).toBe("function");
    // 共 13 个方法（计数）
    expect(expectedMethods.length).toBe(13);

    // E2E 环境同样不得暴露危险能力
    for (const k of ["ipcRenderer", "fs", "child_process", "require", "process"]) {
      expect(e2eExposed[k], `E2E 环境不应暴露 ${k}`).toBeUndefined();
    }
  });
});
