/**
 * P1-8 Commit 3 — Engine 结果 parser 专项测试。
 *
 * 覆盖：
 *   1. ENGINE_RESULT_PARSERS 穷尽性（42 key == ENGINE_METHOD_NAMES == CONTRACT keys）；
 *   2. 每个 method 的 result.schemaId 存在于 RESULT_SCHEMA_REGISTRY；
 *   3. 34 个唯一 result schema_id 各有最小真实 fixture；
 *   4. 42 个方法用合法 fixture 解析通过；
 *   5. 42 个方法用 null 顶层结果拒绝（证明无 identity parser）；
 *   6. 未知 method / Electron local method 拒绝；
 *   7. 映射错误防护（结构差异明显的方法不能串用 fixture）。
 */
import { describe, it, expect } from "vitest";
import {
  ENGINE_METHOD_NAMES,
  ENGINE_METHOD_RESULT_CONTRACT,
  ENGINE_RESULT_PARSERS,
  RESULT_SCHEMA_REGISTRY,
  parseMethodResult,
  type EngineResultSchemaId,
} from "@shared/index";

// --------------------------------------------------------------------------- //
// 34 个唯一 result schema_id 的最小真实 fixture。
//
// 每个 fixture 必须满足对应 Zod schema 的全部必需字段约束（UUID、时间戳、
// 枚举、分页范围等），不使用空对象万能 fixture，不使用 as any。
// 复杂对象（layout context、ocr search）尽量复用 contract.spec.ts 已验证形状。
// --------------------------------------------------------------------------- //

const UUID = "00000000-0000-4000-8000-000000000001";
const ISO = "2026-07-28T00:00:00Z";

const rect = { x0: 100, y0: 200, x1: 180, y1: 720 };
const normRect = { x0: 0.1, y0: 0.1, x1: 0.18, y1: 0.36 };

const layoutContext = {
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
  normalized_bbox: normRect,
  block_bbox: rect,
  normalized_block_bbox: normRect,
  items: [{
    ocr_line_id: "line-7",
    line_index: 7,
    role: "target",
    text: "至其虧空錢粮",
    bbox: rect,
    normalized_bbox: normRect,
    match_start: 2,
    match_end: 4,
  }],
  candidate_blocks: [{
    id: "block-1",
    orientation: "vertical",
    line_count: 3,
    bbox: rect,
    normalized_bbox: normRect,
    contains_target: true,
  }],
};

const layoutRebuildProgress = {
  task_id: "task-1",
  version: 2,
  total: 10,
  completed: 4,
  failed: 0,
  remaining: 6,
  batch_processed: 1,
  batch_failed: 0,
};

const ocrSearchQueryForms = {
  forms: {
    original: "亏空",
    simplified: "亏空",
    traditional: "虧空",
    taiwan: "虧空",
    hong_kong: "虧空",
  },
  semantic_status: "glyph_only_unconfirmed",
  semantic_label: "仅字形关联",
  opencc_phrase_evidence: {},
  single_character_variants: [],
};

const ocrSearchCounts = {
  total: 1,
  layers: { variant_graph: 1 },
  scripts: { traditional: 1 },
  verification: { variant_related: 1 },
  candidate_pending_review: 0,
  corpus_status: "ready",
  corpus_incomplete: false,
};

const ocrSearchSession = {
  search_session_id: "search-1",
  task_id: "task-1",
  query_text: "亏空",
  normalized_query: "亏空",
  script_scope: "both",
  status: "completed",
  corpus_version: 1,
  query_forms: ocrSearchQueryForms,
  counts: ocrSearchCounts,
  created_at: ISO,
  completed_at: ISO,
};

const ocrSearchHit = {
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

const exportJob = {
  export_id: "exp-1",
  task_id: "task-1",
  format: "html",
  status: "queued",
  current_stage: "",
  progress_completed: 0,
  progress_total: 0,
  output_path: "",
  error_code: "",
  error_message: "",
  cancel_requested: false,
  retry_of: "",
  cleanup_status: "pending",
  cleanup_error_code: "",
  cleanup_error_message: "",
  cleanup_attempt_count: 0,
  created_at: ISO,
  started_at: null,
  finished_at: null,
};

const sourcePreflightResult = {
  source_dir: "E:\\OCR",
  supported_file_count: 1,
  unsupported_file_count: 0,
  duplicate_count: 0,
  total_bytes: 1024,
  format_counts: { pdf: 1 },
  known_pages: 1,
  estimated_pages: 1,
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
};

const sourcePreflightJob = {
  preflight_id: "preflight-1",
  source_dir: "E:\\OCR",
  status: "completed",
  result: sourcePreflightResult,
  error_code: null,
  error_message: null,
  created_at: ISO,
  updated_at: ISO,
  finished_at: ISO,
};

const taskBase = {
  task_id: "task-1",
  status: "running",
  search_text: "档案",
  search_terms: ["档案"],
  search_mode: "exact_literal",
  processed_pages: 3,
  total_pages: 10,
  occurrence_count: 2,
  worker_generation: 1,
  last_event_sequence: 5,
};

const checkpoint = {
  task_id: "task-1",
  source_id: "src-1",
  last_completed_page: 2,
  next_page: 3,
  processed_page_ids: [1, 2],
  worker_generation: 1,
  updated_at: ISO,
};

/** 34 个唯一 result schema_id → 最小真实 fixture。
 *  satisfies Record<EngineResultSchemaId, unknown> 保证：缺少任一 schema ID、
 *  拼写错误或多余 schema ID 时 typecheck 失败。 */
const VALID_RESULT_FIXTURES_BY_SCHEMA_ID = {
  AppInfoResult: {
    engine_version: "0.1.0",
    protocol_version: 4,
    python_executable: "/usr/bin/python",
  },
  AppShutdownResult: { status: "shutting_down" },
  DemoCreateResult: {
    task_id: "task-1",
    workspace_dir: "/tmp/task-1",
    status: "completed",
    occurrence_count: 3,
    is_demo: true,
  },
  DiagnosticsResult: {
    engine_version: "0.1.0",
    python_version: "3.11.0",
    python_executable: "/usr/bin/python",
    platform: "win32",
    overall: "PASS",
    checks: [],
  },
  ExportHtmlResult: { path: "/tmp/out.html", occurrence_count: 5, file_size_bytes: 1024 },
  ExportJob: exportJob,
  ExportJobActionResult: { export_id: "exp-1", status: "cancelling" },
  ExportJobCreateResult: { export_id: "exp-2", task_id: "task-1", format: "json", status: "queued" },
  ExportJobsListResult: { task_id: "task-1", items: [exportJob], limit: 50, offset: 0, total: 1 },
  ExportJsonResult: { path: "/tmp/out.json", occurrence_count: 5 },
  ExportReviewResult: { path: "/tmp/out.review", record_count: 3 },
  ExportsListResult: { task_id: "task-1", items: [{ export_id: "exp-1", task_id: "task-1", kind: "html", path: "/tmp/out.html", created_at: ISO }], limit: 20, offset: 0 },
  LayoutRebuildProgress: layoutRebuildProgress,
  OccurrenceDetail: { occurrence_id: "occ-1", layout_context: null },
  OcrCorpusStatusResult: {
    task_id: "task-1",
    status: "ready",
    corpus_version: 1,
    model_id: "model-1",
    model_sha256: "abc",
    indexed_pages: 10,
    line_count: 100,
    requires_reocr: false,
  },
  OcrSearchHitsResult: {
    search_session_id: "search-1",
    task_id: "task-1",
    session: ocrSearchSession,
    total: 1,
    limit: 100,
    offset: 0,
    has_more: false,
    items: [ocrSearchHit],
  },
  OcrSearchSession: ocrSearchSession,
  OcrSearchSessionsResult: { task_id: "task-1", items: [ocrSearchSession] },
  ResultsQueryResult: {
    task_id: "task-1",
    total: 1,
    limit: 100,
    offset: 0,
    has_more: false,
    review_summary: { reviewed_count: 0, unreviewed_count: 1, confirmed_count: 0, needs_review_count: 0, rejected_count: 0 },
    task_status: "running",
    scan_complete: false,
    review_complete: false,
    layout_rebuild: layoutRebuildProgress,
    items: [{ occurrence_id: "occ-1" }],
  },
  ReviewLayoutContextResult: { task_id: "task-1", occurrence_id: "occ-1", context: layoutContext },
  ReviewPageImageResult: {
    asset_relpath: "pages/p.png",
    asset_version: "v1",
    pixel_width: 1920,
    pixel_height: 2560,
    width_100_css: 960,
    height_100_css: 1280,
    source_kind: "pdf",
    fidelity: "verified_source",
    overscale_warning: null,
  },
  ReviewUpdateDecisionResult: { occurrence_id: "occ-1", decision: "confirmed", updated_at: ISO },
  ReviewUpdateDecisionsResult: {
    task_id: "task-1",
    operation_id: UUID,
    updated_at: ISO,
    items: [{ occurrence_id: "occ-1", previous_decision: null, decision: "confirmed" }],
  },
  ReviewUpdateLayoutOverrideResult: {
    task_id: "task-1",
    occurrence_id: "occ-1",
    context: layoutContext,
    progress: layoutRebuildProgress,
  },
  ReviewUpdateNoteResult: { occurrence_id: "occ-1", note: "批注", updated_at: ISO },
  SourcePreflightJob: sourcePreflightJob,
  StorageCleanupResult: { attempted: 2, completed: 1, failed: 1, skipped_active: 1, remaining: 1 },
  TaskActionResult: { task_id: "task-1", status: "running" },
  TaskCleanupTargetResult: { task_id: "task-1", path: "E:\\residual" },
  TaskCreateResult: {
    task_id: "task-1",
    status: "draft",
    source_dir: "E:\\OCR",
    file_count: 1,
    search_text: "档案",
    search_terms: ["档案"],
    search_mode: "exact_literal",
  },
  TaskDeleteResult: { task_id: "task-1", deleted: true },
  TaskInspectStateResult: {
    task: taskBase,
    task_id: "task-1",
    source_id: "src-1",
    processed_page_ids: [1, 2],
    occurrence_ids: ["occ-1"],
    checkpoint,
    events: [],
    occurrence_count: 1,
  },
  TaskSummary: taskBase,
  TasksListResult: { items: [taskBase], limit: 50, offset: 0, total: 1 },
} satisfies Record<EngineResultSchemaId, unknown>;

describe("P1-8 Commit 3 — Engine 结果 parser registry", () => {
  it("registry 穷尽性：keys == ENGINE_METHOD_NAMES == CONTRACT keys（42）", () => {
    const parserKeys = Object.keys(ENGINE_RESULT_PARSERS).sort();
    const methodNames = [...ENGINE_METHOD_NAMES].sort();
    const contractKeys = Object.keys(ENGINE_METHOD_RESULT_CONTRACT).sort();
    expect(parserKeys.length).toBe(42);
    expect(methodNames.length).toBe(42);
    expect(contractKeys.length).toBe(42);
    expect(parserKeys).toEqual(methodNames);
    expect(parserKeys).toEqual(contractKeys);
  });

  it("每个方法的 result.schemaId 存在于 RESULT_SCHEMA_REGISTRY", () => {
    for (const method of ENGINE_METHOD_NAMES) {
      const contract = ENGINE_METHOD_RESULT_CONTRACT[method];
      if (contract.kind === "schema") {
        expect(
          contract.schemaId in RESULT_SCHEMA_REGISTRY,
          `${method} 的 schemaId ${contract.schemaId} 不在 RESULT_SCHEMA_REGISTRY`,
        ).toBe(true);
      }
    }
  });

  it("34 个唯一 result schema_id 全部有有效 fixture", () => {
    const uniqueSchemaIds = new Set<string>();
    for (const method of ENGINE_METHOD_NAMES) {
      const c = ENGINE_METHOD_RESULT_CONTRACT[method];
      if (c.kind === "schema") uniqueSchemaIds.add(c.schemaId);
    }
    expect(uniqueSchemaIds.size).toBe(34);
    const missing = [...uniqueSchemaIds].filter((id) => !(id in VALID_RESULT_FIXTURES_BY_SCHEMA_ID));
    expect(missing, `缺少 fixture 的 schema_id: ${missing.join(", ")}`).toEqual([]);
  });

  it("parser 与正式契约对象身份一致：ENGINE_RESULT_PARSERS[method] === RESULT_SCHEMA_REGISTRY[contract.schemaId]", () => {
    // 不只检查 parser 是函数或 fixture 能解析，而是验证 parser 引用的 Zod schema
    // 与契约声明的 schemaId 在 RESULT_SCHEMA_REGISTRY 中是同一对象（===）。
    for (const method of ENGINE_METHOD_NAMES) {
      const resultContract = ENGINE_METHOD_RESULT_CONTRACT[method];
      if (resultContract.kind !== "schema") {
        throw new Error(`当前方法出现未实现的 result kind: ${method}`);
      }
      expect(
        ENGINE_RESULT_PARSERS[method],
        `${method} parser 未引用契约声明的 schema`,
      ).toBe(RESULT_SCHEMA_REGISTRY[resultContract.schemaId]);
    }
  });

  it("42 个方法用合法 fixture 解析通过", () => {
    for (const method of ENGINE_METHOD_NAMES) {
      const contract = ENGINE_METHOD_RESULT_CONTRACT[method];
      if (contract.kind !== "schema") continue; // 当前无 empty_object
      const fixture = VALID_RESULT_FIXTURES_BY_SCHEMA_ID[contract.schemaId];
      expect(fixture, `${method} 的 schemaId ${contract.schemaId} 缺少 fixture`).toBeDefined();
      expect(
        () => ENGINE_RESULT_PARSERS[method].parse(fixture),
        `${method} 应接受 schemaId=${contract.schemaId} 的合法 fixture`,
      ).not.toThrow();
    }
  });

  it("42 个方法用 null 顶层结果拒绝（证明无 identity parser）", () => {
    for (const method of ENGINE_METHOD_NAMES) {
      expect(
        () => ENGINE_RESULT_PARSERS[method].parse(null),
        `${method} 应拒绝 null（不能是 identity parser）`,
      ).toThrow();
    }
  });

  it("parseMethodResult 拒绝未知 method", () => {
    expect(() => parseMethodResult("bogus.method", {})).toThrow();
  });

  it("parseMethodResult 拒绝 Electron local method（settings.get 不是 Engine 方法）", () => {
    expect(() => parseMethodResult("settings.get", {})).toThrow();
    expect(() => parseMethodResult("files.openOriginal", {})).toThrow();
    expect(() => parseMethodResult("app.getVersion", {})).toThrow();
  });

  it("映射错误防护：结构差异明显的方法不能串用 fixture", () => {
    // tasks.get（TaskSummary）不接受 TaskActionResult fixture
    expect(() => ENGINE_RESULT_PARSERS["tasks.get"].parse({ task_id: "task-1", status: "running" })).toThrow();
    // app.shutdown（AppShutdownResult）不接受 AppInfo fixture
    expect(() => ENGINE_RESULT_PARSERS["app.shutdown"].parse(VALID_RESULT_FIXTURES_BY_SCHEMA_ID["AppInfoResult"])).toThrow();
    // exports.get（ExportJob）不接受 ExportJobCreateResult fixture
    expect(() => ENGINE_RESULT_PARSERS["exports.get"].parse(VALID_RESULT_FIXTURES_BY_SCHEMA_ID["ExportJobCreateResult"])).toThrow();
    // search.hits（OcrSearchHitsResult）不接受 OcrSearchSession fixture
    expect(() => ENGINE_RESULT_PARSERS["search.hits"].parse(VALID_RESULT_FIXTURES_BY_SCHEMA_ID["OcrSearchSession"])).toThrow();
  });
});
