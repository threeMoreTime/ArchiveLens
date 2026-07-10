import { describe, expect, it, vi } from "vitest";
import { SidecarManager } from "../src/main/sidecar/manager";

function ready(payload: unknown, outerVersion = 2): string {
  return JSON.stringify({ protocol_version: outerVersion, event: "engine.ready", task_id: null, payload });
}

describe("Sidecar protocol v2 handshake", () => {
  it("marks ready only for a valid v2 payload", () => {
    const manager = new SidecarManager();
    (manager as any).onLine(ready({ protocol_version: 2, engine_version: "0.1.0-alpha.11" }));
    expect(manager.isReady).toBe(true);
  });

  for (const [name, line] of [
    ["payload v1", ready({ protocol_version: 1, engine_version: "old" })],
    ["outer v1", ready({ protocol_version: 2, engine_version: "new" }, 1)],
    ["missing payload version", ready({ engine_version: "missing" })],
    ["string payload version", ready({ protocol_version: "2", engine_version: "bad" })],
    ["future payload version", ready({ protocol_version: 3, engine_version: "future" })],
  ] as const) {
    it(`rejects ${name}, clears pending, and terminates the child`, () => {
      const manager = new SidecarManager();
      const startupReject = vi.fn();
      const pendingReject = vi.fn();
      const terminate = vi.spyOn(manager as any, "terminateProtocolFault").mockImplementation(() => undefined);
      (manager as any).readyWaiters.push({ resolve: vi.fn(), reject: startupReject, timer: setTimeout(() => undefined, 60_000) });
      (manager as any).pending.set("request-1", { resolve: vi.fn(), reject: pendingReject, timer: setTimeout(() => undefined, 60_000) });

      (manager as any).onLine(line);

      expect(manager.isReady).toBe(false);
      expect(startupReject).toHaveBeenCalledWith(expect.objectContaining({ code: "PROTOCOL_MISMATCH" }));
      expect(pendingReject).toHaveBeenCalledWith(expect.objectContaining({ code: "PROTOCOL_MISMATCH" }));
      expect((manager as any).readyWaiters).toHaveLength(0);
      expect((manager as any).pending.size).toBe(0);
      expect(terminate).toHaveBeenCalledOnce();
    });
  }
});
