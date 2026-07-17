import { describe, expect, it } from "vitest";
import { cleanupStatusView, effectiveCleanupStatus, taskStatusView } from "../src/renderer/src/utils/presentation";

describe("task status presentation", () => {
  it.each([
    ["draft", "待启动", "WARN"],
    ["queued", "排队中", "WARN"],
    ["starting", "正在启动", "WARN"],
    ["running", "扫描中", "WARN"],
    ["pausing", "正在暂停", "WARN"],
    ["paused", "已暂停", "WARN"],
    ["resuming", "正在恢复", "WARN"],
    ["recoverable", "可恢复", "WARN"],
    ["stopping", "正在取消", "WARN"],
    ["stale", "状态异常", "FAIL"],
    ["completed", "已完成", "PASS"],
    ["failed", "失败", "FAIL"],
    ["cancelled", "已取消", "FAIL"],
  ] as const)("maps %s to localized label and tone", (status, label, tone) => {
    expect(taskStatusView({ status, failure_count: 0 })).toEqual({ label, tone });
  });

  it("keeps partially completed tasks visible as a warning", () => {
    expect(taskStatusView({ status: "completed", failure_count: 3 })).toEqual({
      label: "部分完成（3 项失败）",
      tone: "WARN",
    });
  });
});

describe("cleanup status presentation", () => {
  it("maps persisted cleanup lifecycle to badge", () => {
    expect(cleanupStatusView("pending")).toEqual({ label: "正在删除", tone: "WARN" });
    expect(cleanupStatusView("cleanup_failed")).toEqual({ label: "清理失败", tone: "FAIL" });
    expect(cleanupStatusView(undefined)).toBeNull();
    expect(cleanupStatusView(null)).toBeNull();
  });

  it("treats an in-flight delete of this row as optimistic pending", () => {
    const task = { task_id: "task-a", cleanup_status: undefined as string | undefined };
    // 非本行删除：无 cleanup 状态
    expect(effectiveCleanupStatus(task, "task-b")).toBeUndefined();
    expect(effectiveCleanupStatus(task, null)).toBeUndefined();
    // 本行正在删除：optimistic pending（请求在途立即显示“正在删除”并隐藏入口）
    expect(effectiveCleanupStatus(task, "task-a")).toBe("pending");
  });

  it("prefers persisted cleanup_status over optimistic pending", () => {
    expect(effectiveCleanupStatus({ task_id: "task-a", cleanup_status: "cleanup_failed" }, "task-a")).toBe("cleanup_failed");
    expect(effectiveCleanupStatus({ task_id: "task-a", cleanup_status: "pending" }, null)).toBe("pending");
  });
});
