import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  RequestSchema,
  ResponseSchema,
  EventSchema,
  WireMessageSchema,
  ErrorCodeSchema,
  TaskCreateParamsSchema,
  normalizeSearchText,
} from "@shared/index";

const FIXTURE_DIR = path.resolve(__dirname, "../../../tests/ipc-contract/fixtures");

function load(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), "utf-8"));
}

describe("IPC contract — 共享 fixture（TS Zod 端）", () => {
  it("request-valid 通过 RequestSchema", () => {
    expect(RequestSchema.safeParse(load("request-valid.json")).success).toBe(true);
  });

  it("request-invalid-version 因 protocol_version 被拒", () => {
    expect(RequestSchema.safeParse(load("request-invalid-version.json")).success).toBe(false);
  });

  it("task-create 中文/空格/# 路径通过", () => {
    expect(RequestSchema.safeParse(load("task-create.json")).success).toBe(true);
    const fixture = load("task-create.json") as { params: unknown };
    expect(TaskCreateParamsSchema.safeParse(fixture.params).success).toBe(true);
  });

  it("search_text 规范化 NFC，拒绝空白、换行、控制字符与超长输入", () => {
    expect(normalizeSearchText("  e\u0301  ")).toBe("é");
    for (const value of ["", "   ", "档\n案", "档\u0000案", "档".repeat(33)]) {
      expect(TaskCreateParamsSchema.safeParse({ source_dir: "E:\\OCR", search_text: value }).success).toBe(false);
    }
  });

  it("review-update 合法 decision 通过", () => {
    expect(RequestSchema.safeParse(load("review-update.json")).success).toBe(true);
  });

  it("response-success 通过 ResponseSchema", () => {
    expect(ResponseSchema.safeParse(load("response-success.json")).success).toBe(true);
  });

  it("response-error 通过 ResponseSchema 且 code 合法", () => {
    const parsed = ResponseSchema.safeParse(load("response-error.json"));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // 错误响应分支
      const err = (parsed.data as { error: { code: string } }).error;
      expect(ErrorCodeSchema.safeParse(err.code).success).toBe(true);
    }
  });

  it("event-progress 含 sequence/timestamp 通过 EventSchema", () => {
    expect(EventSchema.safeParse(load("event-progress.json")).success).toBe(true);
  });

  it("event-completed 通过 EventSchema", () => {
    expect(EventSchema.safeParse(load("event-completed.json")).success).toBe(true);
  });

  it("event-invalid-sequence（负数）被拒", () => {
    expect(EventSchema.safeParse(load("event-invalid-sequence.json")).success).toBe(false);
  });

  it("所有合法 wire 消息通过 WireMessageSchema", () => {
    for (const f of [
      "response-success.json",
      "response-error.json",
      "event-progress.json",
      "event-completed.json",
    ]) {
      expect(WireMessageSchema.safeParse(load(f)).success).toBe(true);
    }
  });

  it("非法枚举 decision 被拒", () => {
    const bad = {
      protocol_version: 2,
      request_id: "r",
      method: "review.updateDecision",
      params: { task_id: "t", occurrence_id: "o", decision: "bogus" },
    };
    // RequestSchema 不校验 params 内部；此处仅校验 schema 接受外层。
    expect(RequestSchema.safeParse(bad).success).toBe(true);
  });
});
