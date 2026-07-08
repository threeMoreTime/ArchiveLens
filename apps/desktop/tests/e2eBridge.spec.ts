import { beforeEach, describe, expect, it, vi } from "vitest";

type ExposedApi = Record<string, unknown>;

const invoke = vi.fn();
const on = vi.fn();
const off = vi.fn();

function installElectronMock(exposed: ExposedApi): void {
  vi.doMock("electron", () => ({
    contextBridge: {
      exposeInMainWorld: (_name: string, api: unknown) => Object.assign(exposed, api as object),
    },
    ipcRenderer: { invoke, on, off },
  }));
}

describe("E2E preload bridge gate", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env["ARCHIVELENS_E2E"];
  });

  it("生产模式不暴露 test bridge", async () => {
    const exposed: ExposedApi = {};
    installElectronMock(exposed);

    await import("../src/preload/index");

    expect(exposed.test).toBeUndefined();
  });

  it("E2E 模式只暴露受限 test bridge", async () => {
    process.env["ARCHIVELENS_E2E"] = "1";
    const exposed: ExposedApi = {};
    installElectronMock(exposed);

    await import("../src/preload/index");

    const testApi = exposed.test as Record<string, unknown> | undefined;
    expect(testApi).toBeDefined();
    expect(Object.keys(testApi ?? {})).toEqual(["lifecycle", "tray", "window", "engine", "sidecar", "task"]);

    const lifecycle = testApi?.lifecycle as Record<string, unknown> | undefined;
    expect(typeof lifecycle?.requestClose).toBe("function");
    expect(typeof lifecycle?.selectCloseAction).toBe("function");
    expect(typeof lifecycle?.getState).toBe("function");

    const tray = testApi?.tray as Record<string, unknown> | undefined;
    expect(typeof tray?.getState).toBe("function");
    expect(typeof tray?.restoreWindow).toBe("function");

    const windowApi = testApi?.window as Record<string, unknown> | undefined;
    expect(typeof windowApi?.getState).toBe("function");

    const engine = testApi?.engine as Record<string, unknown> | undefined;
    expect(typeof engine?.getPid).toBe("function");

    const sidecar = testApi?.sidecar as Record<string, unknown> | undefined;
    expect(typeof sidecar?.simulateCrash).toBe("function");

    const task = testApi?.task as Record<string, unknown> | undefined;
    expect(typeof task?.getState).toBe("function");
    expect(typeof task?.getProcessedPageIds).toBe("function");
    expect(typeof task?.getOccurrenceIds).toBe("function");
    expect(typeof task?.getCheckpoint).toBe("function");
    expect(typeof task?.getEventSequence).toBe("function");

    expect((testApi as Record<string, unknown>).shell).toBeUndefined();
    expect((testApi as Record<string, unknown>).fs).toBeUndefined();
    expect((testApi as Record<string, unknown>).process).toBeUndefined();
  });
});
