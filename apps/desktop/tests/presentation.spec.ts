import { describe, expect, it } from "vitest";
import { taskStatusView } from "../src/renderer/src/utils/presentation";

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
