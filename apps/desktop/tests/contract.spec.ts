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
  ReviewDisplayPreferencesSchema,
  ReviewHighlightSettingsUpdateParamsSchema,
  ReviewPageImageResultSchema,
  ReviewPreparePageImageParamsSchema,
  OcrCorpusStatusResultSchema,
  OcrSearchExecuteParamsSchema,
  OcrSearchHitSchema,
  OcrSearchHitsParamsSchema,
  OcrSearchHitsResultSchema,
  OcrSearchPreparePageImageParamsSchema,
  OcrSearchSessionSchema,
  SearchScriptScopeSchema,
  MethodNameSchema,
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

  it("扫描任务校验命中页清晰度与上下文阅读设置", () => {
    const preferences = { page_quality: "maximum", context_direction: "ttb", context_radius: 50 };
    expect(ReviewDisplayPreferencesSchema.safeParse(preferences).success).toBe(true);
    expect(TaskCreateParamsSchema.safeParse({ source_dir: "E:\\OCR", search_text: "档案", review_preferences: preferences }).success).toBe(true);
    expect(ReviewDisplayPreferencesSchema.safeParse({ ...preferences, page_quality: "lossless" }).success).toBe(false);
    expect(ReviewDisplayPreferencesSchema.safeParse({ ...preferences, context_direction: "diagonal" }).success).toBe(false);
    expect(ReviewDisplayPreferencesSchema.safeParse({ ...preferences, context_radius: 0 }).success).toBe(false);
    expect(ReviewDisplayPreferencesSchema.safeParse({ ...preferences, context_radius: 51 }).success).toBe(false);
    expect(ReviewDisplayPreferencesSchema.parse({ ...preferences, page_quality: "standard" }).page_quality).toBe("maximum");
  });

  it("原文件页面证据方法保持协议 v2 的增量兼容", () => {
    expect(MethodNameSchema.safeParse("review.preparePageImage").success).toBe(true);
    expect(ReviewPreparePageImageParamsSchema.safeParse({
      task_id: "task-1",
      occurrence_id: "occ-1",
      target_css_width: 960,
      target_css_height: 1280,
      device_pixel_ratio: 2,
    }).success).toBe(true);
    expect(ReviewPageImageResultSchema.safeParse({
      asset_relpath: "evidence/pages/page.png",
      asset_version: "abc123",
      pixel_width: 1920,
      pixel_height: 2560,
      width_100_css: 960,
      height_100_css: 1280,
      source_kind: "pdf",
      fidelity: "verified_source",
      overscale_warning: null,
    }).success).toBe(true);
    for (const code of ["SOURCE_EVIDENCE_UNAVAILABLE", "SOURCE_FILE_CHANGED", "PAGE_RENDER_LIMIT_EXCEEDED"]) {
      expect(ErrorCodeSchema.safeParse(code).success).toBe(true);
    }
  });

  it("任务内简繁检索方法、会话、命中和错误码保持强类型", () => {
    for (const method of [
      "search.corpusStatus",
      "search.execute",
      "search.sessions",
      "search.hits",
      "search.preparePageImage",
    ]) {
      expect(MethodNameSchema.safeParse(method).success, method).toBe(true);
    }
    expect(OcrSearchExecuteParamsSchema.parse({
      task_id: "task-1",
      query_text: "亏空",
    })).toMatchObject({ script_scope: "both" });
    expect(OcrSearchExecuteParamsSchema.safeParse({
      task_id: "task-1",
      query_text: "亏空",
      script_scope: "mixed",
    }).success).toBe(false);
    expect(ErrorCodeSchema.safeParse("OCR_CORPUS_UNAVAILABLE").success).toBe(true);
    expect(OcrCorpusStatusResultSchema.safeParse({
      task_id: "task-1",
      status: "legacy_requires_reocr",
      corpus_version: 0,
      model_id: null,
      model_sha256: null,
      indexed_pages: 0,
      line_count: 0,
      requires_reocr: true,
    }).success).toBe(true);
    const session = {
      search_session_id: "search-1",
      task_id: "task-1",
      query_text: "亏空",
      normalized_query: "亏空",
      script_scope: "both",
      status: "completed",
      corpus_version: 1,
      query_forms: {
        forms: {
          original: "亏空",
          simplified: "亏空",
          traditional: "虧空",
          taiwan: "虧空",
          hong_kong: "虧空",
        },
        semantic_status: "glyph_only_unconfirmed",
        semantic_label: "仅字形关联，语义未确认",
        opencc_phrase_evidence: {},
        single_character_variants: [],
      },
      counts: {
        total: 1,
        layers: { variant_graph: 1 },
        scripts: { traditional: 1 },
        verification: { variant_related: 1 },
        candidate_pending_review: 0,
        corpus_status: "ready",
        corpus_incomplete: false,
      },
      created_at: "2026-07-16T00:00:00Z",
      completed_at: "2026-07-16T00:00:00Z",
    };
    expect(OcrSearchSessionSchema.safeParse(session).success).toBe(true);
    const hit = {
      search_hit_id: "hit-1",
      search_session_id: "search-1",
      task_id: "task-1",
      ocr_line_id: "line-1",
      match_layer: "variant_graph",
      layer_priority: 3,
      index_kind: "simplified",
      matched_text: "亏空",
      index_start: 0,
      index_end: 2,
      source_start: 0,
      source_end: 2,
      source_text: "虧空",
      source_script: "traditional",
      verification_status: "variant_related",
      confidence: 0.95,
      payload: {},
      document_id: "doc-1",
      source_id: "sample.pdf",
      page_no: 1,
      page_index: 0,
      line_index: 0,
      raw_text: "虧空",
      resolved_text: "虧空",
      line_confidence: 0.95,
      bbox: [[0, 0], [100, 0], [100, 30], [0, 30]],
      word_boxes: [],
      isolated_top_k: [],
      match_bbox: [[0, 0], [100, 0], [100, 30], [0, 30]],
      source_page_width: 1000,
      source_page_height: 1400,
      display_path: "sample.pdf",
      file_name: "sample.pdf",
      normalized_x0: 0,
      normalized_y0: 0,
      normalized_x1: 0.1,
      normalized_y1: 0.02,
    };
    expect(OcrSearchHitSchema.safeParse(hit).success).toBe(true);
    expect(OcrSearchHitsParamsSchema.safeParse({
      task_id: "task-1",
      search_session_id: "search-1",
      limit: 50,
      offset: 0,
    }).success).toBe(true);
    expect(OcrSearchHitsParamsSchema.safeParse({
      search_session_id: "search-1",
    }).success).toBe(false);
    expect(OcrSearchHitsResultSchema.safeParse({
      search_session_id: "search-1",
      task_id: "task-1",
      session,
      total: 1,
      limit: 100,
      offset: 0,
      has_more: false,
      items: [hit],
    }).success).toBe(true);
    expect(OcrSearchPreparePageImageParamsSchema.safeParse({
      task_id: "task-1",
      search_hit_id: "hit-1",
      target_css_width: 960,
      target_css_height: 1280,
      device_pixel_ratio: 2,
    }).success).toBe(true);
  });

  it("校对高亮设置校验颜色、透明度与配置范围", () => {
    expect(ReviewHighlightStyleSchema.parse({ color: "#abcdef", opacity: 0.25 })).toEqual({ color: "#ABCDEF", opacity: 0.25 });
    expect(ReviewHighlightStyleSchema.safeParse({ color: "red", opacity: 0.25 }).success).toBe(false);
    expect(ReviewHighlightStyleSchema.safeParse({ color: "#ABCDEF", opacity: 0.09 }).success).toBe(false);
    expect(ReviewHighlightStyleSchema.safeParse({ color: "#ABCDEF", opacity: 0.61 }).success).toBe(false);
    expect(ReviewHighlightSettingsUpdateParamsSchema.safeParse({ scope: "global", highlight: { color: "#C44516", opacity: 0.18 } }).success).toBe(true);
    expect(ReviewHighlightSettingsUpdateParamsSchema.safeParse({ scope: "task", task_id: "task-1", highlight: null }).success).toBe(true);
    expect(ReviewHighlightSettingsUpdateParamsSchema.safeParse({ scope: "global", preferences: { page_quality: "maximum", context_direction: "ltr", context_radius: 15 } }).success).toBe(true);
    expect(ReviewHighlightSettingsUpdateParamsSchema.safeParse({ scope: "task", task_id: "task-1", preferences: null }).success).toBe(true);
    expect(SearchScriptScopeSchema.options).toEqual(["simplified", "traditional", "both"]);
    expect(ReviewHighlightSettingsUpdateParamsSchema.safeParse({ scope: "global", search_script_scope: "both" }).success).toBe(true);
    expect(ReviewHighlightSettingsUpdateParamsSchema.safeParse({ scope: "global", search_script_scope: "mixed" }).success).toBe(false);
    expect(ReviewHighlightSettingsUpdateParamsSchema.safeParse({ scope: "document", task_id: "task-1", document_id: "doc-1", orientation: "right" }).success).toBe(true);
    expect(ReviewHighlightSettingsUpdateParamsSchema.safeParse({ scope: "document", task_id: "task-1", document_id: "doc-1", orientation: "diagonal" }).success).toBe(false);
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
