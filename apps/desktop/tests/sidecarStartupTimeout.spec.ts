import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFile: vi.fn((_file, _args, _options, callback) => callback?.(null)),
}));

vi.mock("node:child_process", () => ({
  spawn: mocks.spawn,
  execFile: mocks.execFile,
}));
vi.mock("../src/main/sidecar/paths", () => ({
  resolveEngineCommand: () => ({ exe: "fake-engine", args: ["--serve"], env: {} }),
}));

import {
  SIDECAR_READY_TIMEOUT_MS,
  SidecarManager,
} from "../src/main/sidecar/manager";

function fakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter & { setEncoding: (encoding: string) => void };
    stderr: EventEmitter & { setEncoding: (encoding: string) => void };
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.pid = 43210;
  proc.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  proc.stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.exitCode = null;
  proc.signalCode = null;
  proc.kill = vi.fn(() => true);
  return proc;
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("Sidecar startup timeout", () => {
  it("cleans the waiter, terminates the orphan process and blocks duplicate spawn until exit", async () => {
    vi.useFakeTimers();
    const proc = fakeProcess();
    mocks.spawn.mockReturnValue(proc);
    const manager = new SidecarManager();

    const startup = expect(manager.start()).rejects.toMatchObject({ code: "ENGINE_START_FAILED" });
    await vi.advanceTimersByTimeAsync(SIDECAR_READY_TIMEOUT_MS);
    await startup;

    expect((manager as any).readyWaiters).toHaveLength(0);
    expect(manager.startupErrorSnapshot).toMatchObject({ code: "ENGINE_START_FAILED" });
    expect(mocks.execFile).toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "43210", "/T", "/F"],
      { windowsHide: true },
      expect.any(Function),
    );
    await expect(manager.start()).rejects.toMatchObject({ code: "ENGINE_START_FAILED" });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);

    proc.emit("exit", null, null);
    expect(manager.pid).toBeNull();
  });
});
