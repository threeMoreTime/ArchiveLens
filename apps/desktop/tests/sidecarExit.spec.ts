import { describe, expect, it } from "vitest";
import { classifySidecarExit } from "../src/main/sidecar/manager";

describe("Sidecar exit classification", () => {
  it("normal app shutdown is expected and non-error", () => {
    const exitInfo = classifySidecarExit(0, null, "app_shutdown");
    expect(exitInfo.expected).toBe(true);
    expect(exitInfo.kind).toBe("expected_shutdown");
    expect(exitInfo.reason).toBe("app_shutdown");
  });

  it("forced shutdown is explicit and non-crash", () => {
    const exitInfo = classifySidecarExit(0, null, "forced_shutdown");
    expect(exitInfo.expected).toBe(true);
    expect(exitInfo.kind).toBe("forced_shutdown");
    expect(exitInfo.reason).toBe("forced_shutdown");
  });

  it("non-zero exit without request is a crash", () => {
    const exitInfo = classifySidecarExit(1, null, null);
    expect(exitInfo.expected).toBe(false);
    expect(exitInfo.kind).toBe("crash");
    expect(exitInfo.reason).toBe("unexpected_exit");
  });
});
