import { describe, expect, it } from "vitest";
import {
  DIAGNOSTIC_CODES,
  extractBackendErrorCode,
  toDiagnosticIssue,
  toRendererErrorReport,
} from "../src/renderer/src/utils/diagnosticIssue";

describe("diagnosticIssue", () => {
  it("默认使用 UI 诊断码并附带业务文案，原始错误仅保留于 rawMessage", () => {
    const issue = toDiagnosticIssue("TASK_LIST_LOAD_FAILED", new Error("ECONNREFUSED at socket 5"));
    expect(issue.code).toBe("TASK_LIST_LOAD_FAILED");
    expect(issue.what).toContain("任务列表加载失败");
    expect(issue.impact.length).toBeGreaterThan(0);
    expect(issue.remedy.length).toBeGreaterThan(0);
    expect(issue.rawMessage).toContain("ECONNREFUSED");
  });

  it("识别到后端稳定错误码时优先展示后端码，业务文案仍来自 UI 码", () => {
    const issue = toDiagnosticIssue("REVIEW_RESULTS_LOAD_FAILED", new Error("Engine failed: TASK_NOT_FOUND"));
    expect(issue.code).toBe("TASK_NOT_FOUND");
    expect(issue.what).toContain("校对结果加载失败");
  });

  it("显式 backendCode 覆盖自动探测", () => {
    const issue = toDiagnosticIssue("EXPORT_JOB_FAILED", new Error("boom"), { backendCode: "DISK_SPACE_LOW" });
    expect(issue.code).toBe("DISK_SPACE_LOW");
  });

  it("extractBackendErrorCode 从 code 属性或消息中提取，未知返回 null", () => {
    expect(extractBackendErrorCode({ code: "IPC_TIMEOUT" })).toBe("IPC_TIMEOUT");
    expect(extractBackendErrorCode(new Error("wrapped PROTOCOL_MISMATCH here"))).toBe("PROTOCOL_MISMATCH");
    expect(extractBackendErrorCode(new Error("no known code"))).toBeNull();
  });

  it("extractBackendErrorCode 处理非字符串 code 属性、字符串错误、null/非对象", () => {
    // code 属性为非字符串 → 跳过属性分支，走 message 匹配
    expect(extractBackendErrorCode({ code: 123 })).toBeNull();
    // 错误本身是字符串
    expect(extractBackendErrorCode("失败码 TASK_NOT_FOUND")).toBe("TASK_NOT_FOUND");
    expect(extractBackendErrorCode("无码字符串")).toBeNull();
    // null / 非对象
    expect(extractBackendErrorCode(null)).toBeNull();
    expect(extractBackendErrorCode(undefined)).toBeNull();
  });

  it("toDiagnosticIssue 对非 Error 输入（字符串/未知）生成默认 rawMessage 且无 stack", () => {
    const fromString = toDiagnosticIssue("EXPORT_JOB_FAILED", "纯字符串错误");
    expect(fromString.rawMessage).toBe("纯字符串错误");
    expect(fromString.rawStack).toBeUndefined();
    const fromUnknown = toDiagnosticIssue("EXPORT_JOB_FAILED", { weird: true });
    expect(fromUnknown.rawMessage).toBe("未知错误");
    expect(fromUnknown.rawStack).toBeUndefined();
  });

  it("toRendererErrorReport 携带操作、任务、码与原始消息/调用栈", () => {
    const error = new Error("raw detail");
    const issue = toDiagnosticIssue("SETTINGS_SAVE_FAILED", error);
    const report = toRendererErrorReport("settings.update", issue, "task-1");
    expect(report).toMatchObject({ operation: "settings.update", task_id: "task-1", code: "SETTINGS_SAVE_FAILED", message: "raw detail" });
    expect(typeof report.stack).toBe("string");
  });

  it("覆盖计划要求的全部稳定诊断码", () => {
    for (const code of [
      "ENVIRONMENT_CHECK_FAILED",
      "TASK_LIST_LOAD_FAILED",
      "TASK_STATUS_READ_FAILED",
      "TASK_ACTION_FAILED",
      "TASK_SCAN_PARTIAL",
      "NEW_SCAN_PREFLIGHT_FAILED",
      "NEW_SCAN_CREATE_FAILED",
      "SEARCH_DATA_LOAD_FAILED",
      "SEARCH_EXECUTION_FAILED",
      "SEARCH_PAGE_EVIDENCE_FAILED",
      "REVIEW_RESULTS_LOAD_FAILED",
      "REVIEW_ACTION_FAILED",
      "REVIEW_PAGE_EVIDENCE_FAILED",
      "REVIEW_LAYOUT_CONTEXT_FAILED",
      "REVIEW_LAYOUT_REBUILD_FAILED",
      "SETTINGS_LOAD_FAILED",
      "SETTINGS_SAVE_FAILED",
      "LOCAL_DATA_READ_FAILED",
      "LOCAL_DATA_ACTION_FAILED",
      "EXPORT_LOAD_FAILED",
      "EXPORT_JOB_FAILED",
      "EXPORT_CLEANUP_FAILED",
      "EXPORT_ACTION_FAILED",
    ]) {
      expect(DIAGNOSTIC_CODES).toContain(code);
    }
  });
});
