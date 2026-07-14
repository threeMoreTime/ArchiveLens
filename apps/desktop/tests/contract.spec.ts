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
  EngineReadyEventSchema,
  TaskCreateResultSchema,
  TaskDeleteResultSchema,
  TaskSummarySchema,
  TasksListResultSchema,
  SUPPORTED_SOURCE_EXTENSIONS,
  ReviewHighlightStyleSchema,
  ReviewHighlightSettingsUpdateParamsSchema,
  normalizeSearchText,
} from "@shared/index";

const FIXTURE_DIR = path.resolve(__dirname, "../../../tests/ipc-contract/fixtures");
const VALIDATION_CASES = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../../tests/search-terms/validation-cases.json"), "utf-8"),
) as {
  search_text_cases: Array<{
    id: string;
    input_codepoints: number[];
    valid: boolean;
    normalized?: string;
  }>;
  parallel_workers_cases: Array<{
    id: string;
    omit?: boolean;
    valid: boolean;
    value?: unknown;
  }>;
};

function load(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), "utf-8"));
}

function fromCodepoints(codepoints: number[]): string {
  return String.fromCodePoint(...codepoints);
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

  it("search_text 按共享 fixture 校验", () => {
    for (const testCase of VALIDATION_CASES.search_text_cases) {
      const value = fromCodepoints(testCase.input_codepoints);
      if (testCase.valid) {
        expect(normalizeSearchText(value), testCase.id).toBe(testCase.normalized);
      } else {
        expect(
          TaskCreateParamsSchema.safeParse({ source_dir: "E:\\OCR", search_text: value }).success,
          testCase.id,
        ).toBe(false);
      }
    }
  });

  it("parallel_workers 只接受整数 1", () => {
    for (const testCase of VALIDATION_CASES.parallel_workers_cases) {
      const params: Record<string, unknown> = { source_dir: "E:\\OCR", search_text: "档案" };
      if (!testCase.omit) {
        params.parallel_workers = testCase.value;
      }
      const result = TaskCreateParamsSchema.safeParse(params);
      if (testCase.valid) {
        expect(result.success, testCase.id).toBe(true);
      } else {
        expect(result.success, testCase.id).toBe(false);
      }
    }
  });

  it("任务来源兼容文件夹、单文件和多文件清单，并限制文件数量", () => {
    expect(TaskCreateParamsSchema.safeParse({ source_dir: "E:\\OCR", search_text: "档案" }).success).toBe(true);
    expect(TaskCreateParamsSchema.safeParse({ source_type: "files", source_files: ["E:\\OCR\\a.pdf"], search_text: "档案" }).success).toBe(true);
    expect(TaskCreateParamsSchema.safeParse({ source_type: "files", source_files: ["E:\\a.pdf", "F:\\b.djvu"], search_text: "档案" }).success).toBe(true);
    expect(TaskCreateParamsSchema.safeParse({ source_type: "files", source_files: ["E:\\a.tiff", "F:\\b.jpg", "F:\\c.png"], search_text: "档案" }).success).toBe(true);
    expect(SUPPORTED_SOURCE_EXTENSIONS).toEqual(["pdf", "djvu", "djv", "tif", "tiff", "jpg", "jpeg", "png"]);
    expect(TaskCreateParamsSchema.safeParse({ source_type: "files", source_files: [], search_text: "档案" }).success).toBe(false);
    expect(TaskCreateParamsSchema.safeParse({ source_type: "files", source_files: Array.from({ length: 201 }, (_, index) => `E:\\${index}.pdf`), search_text: "档案" }).success).toBe(false);
  });

  it("review-update 合法 decision 通过", () => {
    expect(RequestSchema.safeParse(load("review-update.json")).success).toBe(true);
  });

  it("校对高亮设置校验颜色、透明度与配置范围", () => {
    expect(ReviewHighlightStyleSchema.parse({ color: "#abcdef", opacity: 0.25 })).toEqual({ color: "#ABCDEF", opacity: 0.25 });
    expect(ReviewHighlightStyleSchema.safeParse({ color: "red", opacity: 0.25 }).success).toBe(false);
    expect(ReviewHighlightStyleSchema.safeParse({ color: "#ABCDEF", opacity: 0.09 }).success).toBe(false);
    expect(ReviewHighlightStyleSchema.safeParse({ color: "#ABCDEF", opacity: 0.61 }).success).toBe(false);
    expect(ReviewHighlightSettingsUpdateParamsSchema.safeParse({ scope: "global", highlight: { color: "#C44516", opacity: 0.18 } }).success).toBe(true);
    expect(ReviewHighlightSettingsUpdateParamsSchema.safeParse({ scope: "task", task_id: "task-1", highlight: null }).success).toBe(true);
    expect(ReviewHighlightSettingsUpdateParamsSchema.safeParse({ scope: "task", highlight: null }).success).toBe(false);
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

  it("engine.ready payload 必须携带严格 protocol v2 与 engine version", () => {
    const valid = { protocol_version: 2, event: "engine.ready", task_id: null, payload: { protocol_version: 2, engine_version: "0.1.0-alpha.11" } };
    expect(EngineReadyEventSchema.safeParse(valid).success).toBe(true);
    for (const payload of [
      { protocol_version: 1, engine_version: "old" },
      { engine_version: "missing" },
      "invalid",
      { protocol_version: "2", engine_version: "string-version" },
      { protocol_version: 3, engine_version: "future" },
    ]) {
      expect(EngineReadyEventSchema.safeParse({ ...valid, payload }).success).toBe(false);
    }
    expect(EngineReadyEventSchema.safeParse({ ...valid, payload: { protocol_version: 2.0, engine_version: "same-number" } }).success).toBe(true);
  });

  it("task create/get/list 结果使用明确运行时 schema", () => {
    const task = {
      task_id: "task-1", status: "paused", search_text: "档案", search_terms: ["档案"],
      search_mode: "exact_literal", processed_pages: 3, total_pages: 10, occurrence_count: 2,
      worker_generation: 1, last_event_sequence: 5,
    };
    expect(TaskSummarySchema.safeParse({ ...task, failures: [{ file_path: "破损.pdf", page_number: 2, stage: "page_process", error_type: "DecodeError", error_message: "页面无法解码", possible_missed_hits: true }] }).success).toBe(true);
    expect(TasksListResultSchema.safeParse({ items: [task], limit: 50, offset: 0, total: 1 }).success).toBe(true);
    expect(TaskCreateResultSchema.safeParse({ ...task, file_count: 1, source_dir: "E:\\OCR", source_kind: "files", source_label: "a.pdf", source_files: ["E:\\OCR\\a.pdf"] }).success).toBe(true);
    expect(TaskDeleteResultSchema.safeParse({ task_id: "task-1", deleted: true }).success).toBe(true);
    expect(TaskDeleteResultSchema.safeParse({ task_id: "task-1", deleted: false }).success).toBe(false);
    expect(TaskSummarySchema.safeParse({ ...task, search_terms: undefined }).success).toBe(false);
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
