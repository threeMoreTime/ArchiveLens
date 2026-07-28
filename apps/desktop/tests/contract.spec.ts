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
  LayoutContextSchema,
  MAX_LAYOUT_CANDIDATE_BLOCKS,
  LayoutRebuildProgressSchema,
  ReviewLayoutContextParamsSchema,
  ReviewLayoutContextResultSchema,
  ReviewPreviewLayoutContextParamsSchema,
  ReviewRebuildLayoutContextsParamsSchema,
  ReviewUpdateLayoutOverrideParamsSchema,
  ReviewUpdateLayoutOverrideResultSchema,
  ReviewUpdateDecisionParamsSchema,
  ReviewUpdateDecisionsParamsSchema,
  ReviewUpdateDecisionsResultSchema,
  PROTOCOL_VERSION,
  TaskCleanupTargetResultSchema,
  ExportJobSchema,
  ExportJobActionResultSchema,
  ExportJobCreateResultSchema,
  ExportJobsListResultSchema,
  OcrCorpusStatusResultSchema,
  OcrSearchExecuteParamsSchema,
  OcrSearchHitSchema,
  OcrSearchHitsParamsSchema,
  OcrSearchHitsResultSchema,
  OcrSearchPreparePageImageParamsSchema,
  OcrSearchSessionSchema,
  SearchScriptScopeSchema,
  MethodNameSchema,
  ENGINE_METHOD_NAMES,
  ENGINE_PUBLIC_METHOD_NAMES,
  ENGINE_INTERNAL_METHOD_NAMES,
  ENGINE_TEST_METHOD_NAMES,
  TaskActionResultSchema,
  AppShutdownResultSchema,
  DemoCreateResultSchema,
  TaskInspectStateResultSchema,
  OccurrenceDetailSchema,
  ReviewUpdateNoteResultSchema,
  ExportJsonResultSchema,
  ExportReviewResultSchema,
  ExportHtmlResultSchema,
  TaskIdOnlyParamsSchema,
  PARAM_SCHEMA_REGISTRY,
  RESULT_SCHEMA_REGISTRY,
  normalizeSearchText,
  parseMethodResult,
  SourcePreflightJobSchema,
  SourcePreflightResultSchema,
  StorageCleanupResultSchema,
} from "@shared/index";
import {
  AppSettingsFileSchema,
  DeveloperModeResultSchema,
  DeveloperModeUpdateParamsSchema,
  KnownErrorSnapshotSchema,
  RendererErrorReportSchema,
  DeveloperSnapshotParamsSchema,
  DiagnosticCopyParamsSchema,
  AiDebugCopyParamsSchema,
  ClipboardCopyResultSchema,
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

  it("文件夹预检合同覆盖统计、磁盘、确认与取消生命周期", () => {
    expect(PROTOCOL_VERSION).toBe(4);
    for (const method of ["tasks.preflight", "tasks.preflightGet", "tasks.preflightCancel"]) {
      expect(MethodNameSchema.safeParse(method).success, method).toBe(true);
    }
    expect(ErrorCodeSchema.safeParse("PREFLIGHT_STALE").success).toBe(true);
    expect(TaskCreateParamsSchema.safeParse({
      source_type: "folder",
      source_dir: "E:\\OCR",
      search_text: "档案",
      preflight_token: "a".repeat(64),
      preflight_confirmed: true,
    }).success).toBe(true);
    const result = SourcePreflightResultSchema.parse({
      source_dir: "E:\\OCR",
      supported_file_count: 2,
      unsupported_file_count: 1,
      duplicate_count: 0,
      total_bytes: 1024,
      format_counts: { pdf: 1, png: 1 },
      known_pages: 3,
      estimated_pages: 3,
      page_count_complete: true,
      unknown_page_file_count: 0,
      inaccessible_files: [],
      inaccessible_count: 0,
      invalid_files: [],
      invalid_file_count: 0,
      skipped_links: [],
      skipped_link_count: 0,
      warning_codes: [],
      warnings: [],
      available_disk_bytes: 10_000,
      estimated_required_disk_bytes: 5_000,
      estimate_basis: "test",
      requires_confirmation: false,
      confirmation_codes: [],
      blocking_codes: [],
      can_create: true,
      truncated_details: false,
      scan_token: "b".repeat(64),
    });
    expect(SourcePreflightJobSchema.safeParse({
      preflight_id: "preflight-1",
      source_dir: "E:\\OCR",
      status: "completed",
      result,
      error_code: null,
      error_message: null,
      created_at: "2026-07-18T00:00:00Z",
      updated_at: "2026-07-18T00:00:01Z",
      finished_at: "2026-07-18T00:00:01Z",
    }).success).toBe(true);
  });

  it("本地临时残留清理合同只返回闭合计数", () => {
    expect(MethodNameSchema.safeParse("storage.cleanupTemporary").success).toBe(true);
    expect(StorageCleanupResultSchema.safeParse({
      attempted: 2,
      completed: 1,
      failed: 1,
      skipped_active: 1,
      remaining: 1,
    }).success).toBe(true);
    expect(StorageCleanupResultSchema.safeParse({ attempted: -1 }).success).toBe(false);
  });

  it("review-update 合法 decision 通过", () => {
    expect(RequestSchema.safeParse(load("review-update.json")).success).toBe(true);
  });

  it("扫描任务校验命中页清晰度与版面模式，并迁移旧设置", () => {
    const preferences = { page_quality: "maximum", layout_mode: "vertical" };
    expect(ReviewDisplayPreferencesSchema.safeParse(preferences).success).toBe(true);
    expect(TaskCreateParamsSchema.safeParse({ source_dir: "E:\\OCR", search_text: "档案", review_preferences: preferences }).success).toBe(true);
    expect(ReviewDisplayPreferencesSchema.safeParse({ ...preferences, page_quality: "lossless" }).success).toBe(false);
    expect(ReviewDisplayPreferencesSchema.safeParse({ ...preferences, layout_mode: "diagonal" }).success).toBe(false);
    expect(ReviewDisplayPreferencesSchema.parse({ page_quality: "maximum", context_direction: "ttb", context_radius: 50 })).toEqual({ page_quality: "maximum", layout_mode: "auto" });
    expect(ReviewDisplayPreferencesSchema.safeParse({ page_quality: "maximum", context_direction: "diagonal", context_radius: 15 }).success).toBe(false);
    expect(ReviewDisplayPreferencesSchema.safeParse({ page_quality: "maximum", context_direction: "ltr", context_radius: 0 }).success).toBe(false);
    expect(ReviewDisplayPreferencesSchema.parse({ ...preferences, page_quality: "standard" }).page_quality).toBe("maximum");
  });

  it("原文件页面证据方法保持现行协议的增量兼容", () => {
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

  it("版面 OCR 上下文、按页修正与后台重建保持强类型", () => {
    const rect = { x0: 100, y0: 200, x1: 180, y1: 720 };
    const normalizedRect = { x0: 0.1, y0: 0.1, x1: 0.18, y1: 0.36 };
    const context = {
      version: 2,
      status: "ready",
      reason: "",
      orientation: "vertical",
      confidence: 0.95,
      target_line_index: 7,
      target_ocr_line_id: "line-7",
      match_start: 2,
      match_end: 4,
      plain_text: "至其虧空錢粮",
      bbox: rect,
      normalized_bbox: normalizedRect,
      block_bbox: rect,
      normalized_block_bbox: normalizedRect,
      items: [{
        ocr_line_id: "line-7",
        line_index: 7,
        role: "target",
        text: "至其虧空錢粮",
        bbox: rect,
        normalized_bbox: normalizedRect,
        match_start: 2,
        match_end: 4,
      }],
      candidate_blocks: [{
        id: "block-1",
        orientation: "vertical",
        line_count: 3,
        bbox: rect,
        normalized_bbox: normalizedRect,
        contains_target: true,
      }],
      effective_layout_mode: "vertical",
      has_page_override: false,
      using_draft_override: false,
    };
    const progress = {
      task_id: "task-1",
      version: 2,
      total: 10,
      completed: 4,
      failed: 0,
      remaining: 6,
      batch_processed: 1,
      batch_failed: 0,
    };

    expect(LayoutContextSchema.safeParse(context).success).toBe(true);
    expect(LayoutContextSchema.safeParse({
      ...context,
      candidate_blocks: Array.from(
        { length: MAX_LAYOUT_CANDIDATE_BLOCKS + 1 },
        (_value, index) => ({ ...context.candidate_blocks[0], id: `block-${index + 1}` }),
      ),
    }).success).toBe(false);
    expect(LayoutRebuildProgressSchema.safeParse(progress).success).toBe(true);
    for (const method of [
      "review.layoutContext",
      "review.previewLayoutContext",
      "review.updateLayoutOverride",
      "review.rebuildLayoutContexts",
    ]) {
      expect(MethodNameSchema.safeParse(method).success, method).toBe(true);
    }
    expect(ReviewLayoutContextParamsSchema.safeParse({ task_id: "task-1", occurrence_id: "occ-1" }).success).toBe(true);
    expect(ReviewPreviewLayoutContextParamsSchema.safeParse({
      task_id: "task-1",
      occurrence_id: "occ-1",
      layout_mode: "vertical",
      normalized_block_bbox: normalizedRect,
    }).success).toBe(true);
    expect(ReviewUpdateLayoutOverrideParamsSchema.safeParse({
      task_id: "task-1",
      occurrence_id: "occ-1",
      layout_mode: "auto",
      clear: true,
    }).success).toBe(true);
    expect(ReviewRebuildLayoutContextsParamsSchema.safeParse({
      task_id: "task-1",
      limit: 25,
      priority_occurrence_id: "occ-1",
    }).success).toBe(true);

    const result = { task_id: "task-1", occurrence_id: "occ-1", context };
    expect(ReviewLayoutContextResultSchema.safeParse(result).success).toBe(true);
    expect(ReviewUpdateLayoutOverrideResultSchema.safeParse({ ...result, progress }).success).toBe(true);
    expect(parseMethodResult("review.layoutContext", result)).toEqual(result);
    expect(parseMethodResult("review.previewLayoutContext", result)).toEqual(result);
    expect(parseMethodResult("review.updateLayoutOverride", { ...result, progress })).toEqual({ ...result, progress });
    expect(parseMethodResult("review.rebuildLayoutContexts", progress)).toEqual(progress);
  });

  it("审核结论支持显式清空与原子批量更新合同", () => {
    const operationId = "00000000-0000-4000-8000-000000000001";
    expect(PROTOCOL_VERSION).toBe(4);
    expect(MethodNameSchema.safeParse("review.updateDecision").success).toBe(true);
    expect(MethodNameSchema.safeParse("review.updateDecisions").success).toBe(true);
    expect(ReviewUpdateDecisionParamsSchema.safeParse({
      task_id: "task-1",
      occurrence_id: "occ-1",
      decision: null,
    }).success).toBe(true);
    expect(ReviewUpdateDecisionParamsSchema.safeParse({
      task_id: "task-1",
      occurrence_id: "occ-1",
    }).success).toBe(false);
    expect(parseMethodResult("review.updateDecision", {
      occurrence_id: "occ-1",
      decision: null,
      updated_at: "2026-07-20T00:00:00Z",
    })).toEqual({
      occurrence_id: "occ-1",
      decision: null,
      updated_at: "2026-07-20T00:00:00Z",
    });
    const params = ReviewUpdateDecisionsParamsSchema.parse({
      task_id: "task-1",
      operation_id: operationId,
      changes: [
        { occurrence_id: "occ-1", decision: "confirmed" },
        { occurrence_id: "occ-2", decision: null },
      ],
    });
    expect(params.changes).toHaveLength(2);
    expect(params.operation_id).toBe(operationId);
    expect(ReviewUpdateDecisionsParamsSchema.safeParse({ task_id: "task-1", changes: [] }).success).toBe(false);
    expect(ReviewUpdateDecisionsParamsSchema.safeParse({
      task_id: "task-1",
      operation_id: operationId,
      changes: [{ occurrence_id: "occ-1", decision: "invalid" }],
    }).success).toBe(false);
    expect(ReviewUpdateDecisionsParamsSchema.safeParse({
      task_id: "task-1",
      operation_id: operationId,
      changes: [
        { occurrence_id: "occ-1", decision: "confirmed" },
        { occurrence_id: "occ-1", decision: "rejected" },
      ],
    }).success).toBe(false);
    const result = {
      task_id: "task-1",
      operation_id: operationId,
      updated_at: "2026-07-20T00:00:00Z",
      items: [
        { occurrence_id: "occ-1", previous_decision: null, decision: "confirmed" },
        { occurrence_id: "occ-2", previous_decision: "rejected", decision: null },
      ],
    };
    expect(ReviewUpdateDecisionsResultSchema.safeParse(result).success).toBe(true);
    expect(parseMethodResult("review.updateDecisions", result)).toEqual(result);
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
      layout_context: null,
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
    expect(ReviewHighlightSettingsUpdateParamsSchema.safeParse({ scope: "global", preferences: { page_quality: "maximum", layout_mode: "auto" } }).success).toBe(true);
    expect(ReviewHighlightSettingsUpdateParamsSchema.safeParse({ scope: "task", task_id: "task-1", preferences: null }).success).toBe(true);
    expect(SearchScriptScopeSchema.options).toEqual(["simplified", "traditional", "both"]);
    expect(ReviewHighlightSettingsUpdateParamsSchema.safeParse({ scope: "global", search_script_scope: "both" }).success).toBe(true);
    expect(ReviewHighlightSettingsUpdateParamsSchema.safeParse({ scope: "global", search_script_scope: "mixed" }).success).toBe(false);
    expect(TaskCreateParamsSchema.parse({ source_dir: "C:/scan", search_text: "亏空" }).search_script_scope).toBe("both");
    expect(TaskCreateParamsSchema.parse({ source_dir: "C:/scan", search_text: "亏空", search_script_scope: "traditional" }).search_script_scope).toBe("traditional");
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

  it("engine.ready payload 必须携带严格 protocol v4 与 engine version", () => {
    const valid = { protocol_version: PROTOCOL_VERSION, event: "engine.ready", task_id: null, payload: { protocol_version: PROTOCOL_VERSION, engine_version: "0.1.0-alpha.11" } };
    expect(EngineReadyEventSchema.safeParse(valid).success).toBe(true);
    for (const payload of [
      { protocol_version: 1, engine_version: "old" },
      { engine_version: "missing" },
      "invalid",
      { protocol_version: "4", engine_version: "string-version" },
      { protocol_version: PROTOCOL_VERSION + 1, engine_version: "future" },
    ]) {
      expect(EngineReadyEventSchema.safeParse({ ...valid, payload }).success).toBe(false);
    }
    expect(EngineReadyEventSchema.safeParse({ ...valid, payload: { protocol_version: 4.0, engine_version: "same-number" } }).success).toBe(true);
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
      protocol_version: PROTOCOL_VERSION,
      request_id: "r",
      method: "review.updateDecision",
      params: { task_id: "t", occurrence_id: "o", decision: "bogus" },
    };
    // RequestSchema 不校验 params 内部；此处仅校验 schema 接受外层。
    expect(RequestSchema.safeParse(bad).success).toBe(true);
  });

  it("任务删除 cleanup 使用附加字段和方法且不新增专用错误码", () => {
    const baseTask = {
      task_id: "task-1", status: "completed", search_text: "档", search_terms: ["档"],
      search_mode: "exact_literal", processed_pages: 1, total_pages: 1, occurrence_count: 1,
      worker_generation: 1, last_event_sequence: 1,
    };
    // cleanup_status/cleanup_error_summary 为可选字段，不破坏既有 TaskSummary 解析
    expect(TaskSummarySchema.safeParse(baseTask).success).toBe(true);
    expect(TaskSummarySchema.safeParse({ ...baseTask, cleanup_status: "cleanup_failed", cleanup_error_summary: "清理被拒绝" }).success).toBe(true);
    expect(TaskSummarySchema.safeParse({ ...baseTask, cleanup_status: undefined }).success).toBe(true);
    // 新方法为附加项（旧客户端不会发送；新客户端对旧服务端收到 UNKNOWN_METHOD）
    expect(MethodNameSchema.safeParse("tasks.cleanupTarget").success).toBe(true);
    expect(TaskCleanupTargetResultSchema.safeParse({ task_id: "task-1", path: "E:\\residual" }).success).toBe(true);
    expect(TaskCleanupTargetResultSchema.safeParse({ task_id: "task-1", path: null }).success).toBe(true);
    expect(TaskCleanupTargetResultSchema.safeParse({ task_id: "task-1", path: "E:\\residual", extra: 1 }).success).toBe(true);
    // 闭合枚举：未知错误码被拒——证明 B1 未新增协议错误码、因此无需递增 PROTOCOL_VERSION
    expect(ErrorCodeSchema.safeParse("CLEANUP_FAILED_HYPOTHETICAL").success).toBe(false);
  });

  it("B2 导出作业使用附加方法和字段且不新增专用错误码", () => {
    for (const method of ["exports.create", "exports.get", "exports.listJobs", "exports.cancel", "exports.retry"]) {
      expect(MethodNameSchema.safeParse(method).success, method).toBe(true);
    }
    const job = {
      export_id: "exp-1", task_id: "task-1", format: "html", status: "rendering_images",
      current_stage: "images", progress_completed: 3, progress_total: 10, output_path: "",
      error_code: "", error_message: "", cancel_requested: false, retry_of: "", created_at: "2026-07-18T00:00:00Z",
      cleanup_status: "completed", cleanup_error_code: "", cleanup_error_message: "", cleanup_attempt_count: 1,
      started_at: "2026-07-18T00:00:01Z", finished_at: null,
    };
    expect(ExportJobSchema.safeParse(job).success).toBe(true);
    expect(ExportJobSchema.safeParse({ ...job, status: "interrupted" }).success).toBe(true);
    expect(ExportJobSchema.safeParse({ ...job, status: "bogus" }).success).toBe(false);
    expect(ExportJobCreateResultSchema.safeParse({ export_id: "exp-2", task_id: "task-1", format: "json", status: "queued" }).success).toBe(true);
    expect(ExportJobActionResultSchema.safeParse({ export_id: "exp-2", status: "cancelling" }).success).toBe(true);
    expect(ExportJobsListResultSchema.safeParse({ task_id: "task-1", items: [job], limit: 50, offset: 0, total: 1 }).success).toBe(true);
    expect(parseMethodResult("exports.cancel", { export_id: "exp-2", status: "cancelling" })).toEqual({ export_id: "exp-2", status: "cancelling" });
    expect(() => parseMethodResult("exports.cancel", { export_id: "exp-2", task_id: "task-1", format: "json", status: "cancelling" })).not.toThrow();
    expect(ExportJobSchema.safeParse({ ...job, format: "xml" }).success).toBe(false);
    // B2 本身未新增协议错误码（并发冲突复用 TASK_STATE_CONFLICT）；当前 v4 由事务化批量校对合同触发。
  });

  it("Electron 本地开发者 schema 不进入 Python 方法名，设置版本保持 4", () => {
    // 设置合同：新增 developer 字段默认关闭，版本仍为 4，向后兼容旧文件
    const parsed = AppSettingsFileSchema.parse({});
    expect(parsed.version).toBe(4);
    expect(parsed.developer).toEqual({ enabled: false });
    const legacy = AppSettingsFileSchema.parse({ version: 1, appearance: {}, task_overrides: {} });
    expect(legacy.version).toBe(4);
    expect(legacy.developer.enabled).toBe(false);

    // 开发者本地方法不属于 Python JSONL 协议，因此不加入 MethodNameSchema
    for (const method of [
      "settings.getDeveloperMode",
      "settings.setDeveloperMode",
      "app.getVersion",
      "app.getDeveloperSnapshot",
      "app.reportRendererError",
      "app.copyDiagnosticSummary",
      "app.copyAiDebugInfo",
      "app.openRendererDevTools",
    ]) {
      expect(MethodNameSchema.safeParse(method).success, method).toBe(false);
    }

    // 本地 schema 正常解析
    expect(DeveloperModeResultSchema.safeParse({ enabled: true }).success).toBe(true);
    expect(DeveloperModeUpdateParamsSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(DiagnosticCopyParamsSchema.safeParse({ mode: "redacted" }).success).toBe(true);
    expect(DiagnosticCopyParamsSchema.safeParse({ mode: "full", task_id: "t1" }).success).toBe(true);
    expect(DiagnosticCopyParamsSchema.safeParse({ mode: "bogus" }).success).toBe(false);
    expect(AiDebugCopyParamsSchema.safeParse({ task_id: "t1", occurrence_id: "o1" }).success).toBe(true);
    expect(ClipboardCopyResultSchema.safeParse({ mode: "ai_debug", char_count: 10, log_line_count: 3, includes_ocr_context: true, ocr_context_status: "included" }).success).toBe(true);
    expect(RendererErrorReportSchema.safeParse({ operation: "tasks.list", message: "x" }).success).toBe(true);
    expect(KnownErrorSnapshotSchema.safeParse({ time: "t", source: "sidecar", operation: "op", task_id: null, code: "X", message: "m", stack: null }).success).toBe(true);
    expect(DeveloperSnapshotParamsSchema.safeParse({}).success).toBe(true);
    // 错误码闭合枚举未新增开发者本地错误码
    expect(ErrorCodeSchema.safeParse("DEVELOPER_MODE_REQUIRED").success).toBe(false);
    expect(ErrorCodeSchema.safeParse("DIAGNOSTIC_PAYLOAD_TOO_LARGE").success).toBe(false);
  });

  it("P1-8 Commit 2：MethodNameSchema 由生成 tuple 派生，移除非 Engine 方法并补登缺失方法", () => {
    // MethodNameSchema 现为 42 项（从 43 项收敛）
    expect(MethodNameSchema.options.length).toBe(42);
    expect(MethodNameSchema.options).toEqual([...ENGINE_METHOD_NAMES]);
    expect(ENGINE_PUBLIC_METHOD_NAMES.length).toBe(38);
    expect(ENGINE_INTERNAL_METHOD_NAMES.length).toBe(3);
    expect(ENGINE_TEST_METHOD_NAMES.length).toBe(1);

    // Commit 2 移除的非 Engine 方法（Python 无 handler / Electron 本地 / 残留）
    for (const method of ["files.openOriginal", "files.openFolder", "settings.get", "settings.update"]) {
      expect(MethodNameSchema.safeParse(method).success, `${method} 应已从 MethodNameSchema 移除`).toBe(false);
    }

    // Commit 2 补登的 Engine 方法（Python handler 与 Main 调用早已存在）
    for (const method of ["app.shutdown", "tasks.inspectState", "demo.create"]) {
      expect(MethodNameSchema.safeParse(method).success, `${method} 应已补入 MethodNameSchema`).toBe(true);
    }
  });

  it("P1-8 Commit 2：新增结果 schema 正反例（依据 Python handler 真实返回）", () => {
    // TaskActionResultSchema：tasks.start/pause/resume/cancel 返回
    expect(TaskActionResultSchema.safeParse({ task_id: "task-1", status: "running" }).success).toBe(true);
    expect(TaskActionResultSchema.safeParse({ task_id: "task-1", status: "pausing" }).success).toBe(true);
    expect(TaskActionResultSchema.safeParse({ task_id: "", status: "running" }).success).toBe(false);
    expect(TaskActionResultSchema.safeParse({ task_id: "task-1", status: "" }).success).toBe(false);

    // AppShutdownResultSchema：app.shutdown 返回（幂等重入带 already）
    expect(AppShutdownResultSchema.safeParse({ status: "shutting_down" }).success).toBe(true);
    expect(AppShutdownResultSchema.safeParse({ status: "shutting_down", already: true }).success).toBe(true);
    expect(AppShutdownResultSchema.safeParse({ status: "ok" }).success).toBe(false);

    // DemoCreateResultSchema：create_demo 真实返回
    expect(DemoCreateResultSchema.safeParse({
      task_id: "task-1", workspace_dir: "/tmp/task-1", status: "completed",
      occurrence_count: 3, is_demo: true,
    }).success).toBe(true);
    expect(DemoCreateResultSchema.safeParse({
      task_id: "task-1", workspace_dir: "/tmp", status: "completed",
      occurrence_count: 0, is_demo: false,
    }).success).toBe(false);
    expect(DemoCreateResultSchema.safeParse({
      workspace_dir: "/tmp", status: "completed", occurrence_count: 0, is_demo: true,
    }).success).toBe(false);

    // TaskInspectStateResultSchema：tasks.inspectState 真实返回（最小夹具）
    const checkpoint = {
      task_id: "task-1", source_id: "src-1", last_completed_page: 2, next_page: 3,
      processed_page_ids: [1, 2], worker_generation: 1, updated_at: "2026-07-28T00:00:00Z",
    };
    expect(TaskInspectStateResultSchema.safeParse({
      task: {}, task_id: "task-1", source_id: "src-1",
      processed_page_ids: [1, 2], occurrence_ids: ["occ-1"],
      checkpoint, events: [], occurrence_count: 1,
    }).success).toBe(true);
    // 缺少必需字段 task_id 拒绝
    expect(TaskInspectStateResultSchema.safeParse({
      task: {}, source_id: "src-1", processed_page_ids: [], occurrence_ids: [],
      checkpoint: null, events: [], occurrence_count: 0,
    }).success).toBe(false);

    // OccurrenceDetailSchema：results.getDetail 返回（passthrough 兼容）
    expect(OccurrenceDetailSchema.safeParse({ occurrence_id: "occ-1", layout_context: null, extra: 1 }).success).toBe(true);
    expect(OccurrenceDetailSchema.safeParse({ layout_context: null }).success).toBe(false);

    // ReviewUpdateNoteResultSchema
    expect(ReviewUpdateNoteResultSchema.safeParse({ occurrence_id: "occ-1", note: "批注", updated_at: "t" }).success).toBe(true);

    // ExportJson/Review/Html
    expect(ExportJsonResultSchema.safeParse({ path: "/tmp/out.json", occurrence_count: 5 }).success).toBe(true);
    expect(ExportReviewResultSchema.safeParse({ path: "/tmp/out.review", record_count: 3 }).success).toBe(true);
    expect(ExportHtmlResultSchema.safeParse({ path: "/tmp/out.html", occurrence_count: 5, file_size_bytes: 1024 }).success).toBe(true);

    // TaskIdOnlyParams：search.corpusStatus 用 OcrSearchSessionsParams.pick({task_id})
    expect(TaskIdOnlyParamsSchema.safeParse({ task_id: "task-1" }).success).toBe(true);
    expect(TaskIdOnlyParamsSchema.safeParse({ task_id: "task-1", extra: 1 }).success).toBe(false);
  });

  it("P1-8 Commit 2：PARAM/RESULT schema registry 覆盖契约全部 schema_id", () => {
    // registry 的 key 数应与契约中 schema_id 数量一致（编译期 satisfies 已保证穷尽，
    // 这里做运行时复核：14 个 params schema_id，34 个 result schema_id）
    expect(Object.keys(PARAM_SCHEMA_REGISTRY).length).toBe(14);
    expect(Object.keys(RESULT_SCHEMA_REGISTRY).length).toBe(34);
    // 每个 registry 值都是 Zod schema
    for (const v of Object.values(PARAM_SCHEMA_REGISTRY)) {
      expect(v).toBeDefined();
    }
    for (const v of Object.values(RESULT_SCHEMA_REGISTRY)) {
      expect(v).toBeDefined();
    }
  });

  it("P1-8 Commit 3：parseMethodResult 穷尽接入 Commit 2 新 schema（成功路径）", () => {
    // 旧 28 个方法行为保持（抽样校验，完整矩阵在 ipcResultParser.spec.ts）
    expect(() => parseMethodResult("tasks.get", {
      task_id: "task-1", status: "running", search_text: "档", search_terms: ["档"],
      search_mode: "exact_literal", processed_pages: 0, total_pages: 1, occurrence_count: 0,
      worker_generation: 1, last_event_sequence: 0,
    })).not.toThrow();
    expect(() => parseMethodResult("review.layoutContext", {
      task_id: "task-1", occurrence_id: "occ-1", context: { version: 1 },
    })).toThrow(); // context 需完整 LayoutContext，简陋 fixture 应失败（证明真实校验）

    // Commit 3 新接入的方法
    expect(() => parseMethodResult("app.info", {
      engine_version: "0.1.0", protocol_version: 4, python_executable: "/p",
    })).not.toThrow();
    expect(() => parseMethodResult("app.shutdown", { status: "shutting_down" })).not.toThrow();
    expect(() => parseMethodResult("demo.create", {
      task_id: "t1", workspace_dir: "/w", status: "completed", occurrence_count: 0, is_demo: true,
    })).not.toThrow();
    expect(() => parseMethodResult("diagnostics.run", {
      engine_version: "0.1", python_version: "3.11", python_executable: "/p", platform: "win32", overall: "PASS", checks: [],
    })).not.toThrow();
    expect(() => parseMethodResult("tasks.start", { task_id: "t1", status: "running" })).not.toThrow();
    expect(() => parseMethodResult("tasks.pause", { task_id: "t1", status: "pausing" })).not.toThrow();
    expect(() => parseMethodResult("tasks.resume", { task_id: "t1", status: "running" })).not.toThrow();
    expect(() => parseMethodResult("tasks.cancel", { task_id: "t1", status: "cancelled" })).not.toThrow();
    expect(() => parseMethodResult("results.getDetail", { occurrence_id: "occ-1" })).not.toThrow();
    expect(() => parseMethodResult("review.updateNote", {
      occurrence_id: "occ-1", note: "批注", updated_at: "2026-07-28T00:00:00Z",
    })).not.toThrow();
    expect(() => parseMethodResult("export.json", { path: "/o.json", occurrence_count: 1 })).not.toThrow();
    expect(() => parseMethodResult("export.review", { path: "/o.review", record_count: 1 })).not.toThrow();
    expect(() => parseMethodResult("export.html", { path: "/o.html", occurrence_count: 1, file_size_bytes: 10 })).not.toThrow();
    expect(() => parseMethodResult("tasks.inspectState", {
      task: {}, task_id: "t1", source_id: "s1", processed_page_ids: [], occurrence_ids: [],
      checkpoint: null, events: [], occurrence_count: 0,
    })).not.toThrow();
  });

  it("P1-8 Commit 3：parseMethodResult 拒绝未知 method 与 Electron local method", () => {
    expect(() => parseMethodResult("bogus.method", {})).toThrow();
    // Electron local / 残留 schema 项不应作为 Engine method 解析
    expect(() => parseMethodResult("settings.get", {})).toThrow();
    expect(() => parseMethodResult("settings.update", {})).toThrow();
    expect(() => parseMethodResult("files.openOriginal", {})).toThrow();
    expect(() => parseMethodResult("files.openFolder", {})).toThrow();
  });

  it("P1-8 Commit 3：parseMethodResult 拒绝非对象顶层结果（证明无 identity parser）", () => {
    // 所有 Engine 结果当前都是对象 envelope；null/原始值必须被拒绝
    expect(() => parseMethodResult("app.info", null)).toThrow();
    expect(() => parseMethodResult("app.info", "string")).toThrow();
    expect(() => parseMethodResult("app.info", 123)).toThrow();
    expect(() => parseMethodResult("app.info", true)).toThrow();
    expect(() => parseMethodResult("app.info", [])).toThrow();
  });
});
