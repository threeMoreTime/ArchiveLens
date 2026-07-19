import { describe, expect, it } from "vitest";
import { batchEligibility, batchPreview } from "../src/renderer/src/utils/taskBatchActions";


describe("task batch action eligibility", () => {
  it("only pauses actively running tasks without cleanup", () => {
    expect(batchEligibility({ status: "running" }, "pause").executable).toBe(true);
    expect(batchEligibility({ status: "paused" }, "pause")).toMatchObject({ executable: false, label: "跳过" });
    expect(batchEligibility({ status: "running", cleanup_status: "pending" }, "pause").executable).toBe(false);
  });

  it("cancels nonterminal tasks directly but skips terminal and stopping states", () => {
    expect(batchEligibility({ status: "queued" }, "cancel").executable).toBe(true);
    expect(batchEligibility({ status: "paused" }, "cancel").executable).toBe(true);
    expect(batchEligibility({ status: "stopping" }, "cancel").executable).toBe(false);
    expect(batchEligibility({ status: "completed" }, "cancel").executable).toBe(false);
  });

  it("deletes terminal tasks and treats cleanup_failed as retry cleanup", () => {
    expect(batchEligibility({ status: "completed" }, "delete")).toMatchObject({ executable: true, label: "删除任务" });
    expect(batchEligibility({ status: "running" }, "delete").executable).toBe(false);
    expect(batchEligibility({ status: "completed", cleanup_status: "pending" }, "delete").executable).toBe(false);
    expect(batchEligibility({ status: "completed", cleanup_status: "cleanup_failed" }, "delete"))
      .toMatchObject({ executable: true, label: "重试清理" });
  });

  it("reports executable and skipped counts before execution", () => {
    expect(batchPreview([
      { status: "running" },
      { status: "paused" },
      { status: "completed" },
    ], "cancel")).toEqual({ executable: 2, skipped: 1 });
  });
});
