/**
 * ArchiveLens IPC 协议 schema（TypeScript 端）。
 *
 * 与 {@link engine/src/archivelens_engine/protocol.py} 一一对应，
 * 构成 Electron Main ↔ Python Engine 之间的强类型契约。
 *
 * 任何协议变更必须同时修改两端，并更新 tests/ipc-contract 契约测试。
 * 不兼容变更必须同步递增 {@link PROTOCOL_VERSION}。
 */
import { z } from "zod";

/** IPC 协议版本，必须与 Python 侧 `archivelens_engine.PROTOCOL_VERSION` 一致。 */
export const PROTOCOL_VERSION = 2 as const;

export const MAX_SEARCH_TEXT_LENGTH = 32;
export const MAX_SOURCE_FILES = 200;
export const SUPPORTED_SOURCE_EXTENSIONS = ["pdf", "djvu", "djv", "tif", "tiff", "jpg", "jpeg", "png"] as const;
export const SUPPORTED_SOURCE_FORMAT_LABEL = "PDF、DJVU、DJV、TIFF、JPEG 或 PNG";
export const ScanSourceKindSchema = z.enum(["folder", "files"]);

export const ReviewHighlightStyleSchema = z.object({
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, "高亮颜色必须是 6 位十六进制颜色").transform((value) => value.toUpperCase()),
  opacity: z.number().min(0.1).max(0.6),
});
export type ReviewHighlightStyle = z.infer<typeof ReviewHighlightStyleSchema>;

export const DEFAULT_REVIEW_HIGHLIGHT_STYLE: ReviewHighlightStyle = {
  color: "#C44516",
  opacity: 0.18,
};

export const ReviewImageQualitySchema = z.enum(["standard", "clear", "high", "maximum"]);
export type ReviewImageQuality = z.infer<typeof ReviewImageQualitySchema>;

export const ContextReadingDirectionSchema = z.enum(["ltr", "rtl", "ttb", "btt"]);
export type ContextReadingDirection = z.infer<typeof ContextReadingDirectionSchema>;

export const ReviewDisplayPreferencesSchema = z.object({
  page_quality: ReviewImageQualitySchema,
  context_direction: ContextReadingDirectionSchema,
  context_radius: z.number().int().min(1).max(50),
}).transform((preferences) => ({ ...preferences, page_quality: "maximum" as const }));
export type ReviewDisplayPreferences = z.infer<typeof ReviewDisplayPreferencesSchema>;

export const DEFAULT_REVIEW_DISPLAY_PREFERENCES: ReviewDisplayPreferences = {
  page_quality: "maximum",
  context_direction: "ltr",
  context_radius: 15,
};

export const ReviewPageOrientationSchema = z.enum(["up", "right", "down", "left"]);
export type ReviewPageOrientation = z.infer<typeof ReviewPageOrientationSchema>;
export const DEFAULT_REVIEW_PAGE_ORIENTATION: ReviewPageOrientation = "up";
export const ReviewPageOrientationsSchema = z.record(z.string().min(1), ReviewPageOrientationSchema);
export type ReviewPageOrientations = z.infer<typeof ReviewPageOrientationsSchema>;

export const SearchScriptScopeSchema = z.enum(["simplified", "traditional", "both"]);
export type SearchScriptScope = z.infer<typeof SearchScriptScopeSchema>;
export const DEFAULT_SEARCH_SCRIPT_SCOPE: SearchScriptScope = "both";

export const AppSettingsFileSchema = z.object({
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(3),
  appearance: z.object({
    review_highlight: ReviewHighlightStyleSchema.default(DEFAULT_REVIEW_HIGHLIGHT_STYLE),
    review_preferences: ReviewDisplayPreferencesSchema.default(DEFAULT_REVIEW_DISPLAY_PREFERENCES),
    search_script_scope: SearchScriptScopeSchema.default(DEFAULT_SEARCH_SCRIPT_SCOPE),
  }).default({
    review_highlight: DEFAULT_REVIEW_HIGHLIGHT_STYLE,
    review_preferences: DEFAULT_REVIEW_DISPLAY_PREFERENCES,
    search_script_scope: DEFAULT_SEARCH_SCRIPT_SCOPE,
  }),
  task_overrides: z.record(z.string().min(1), z.object({
    review_highlight: ReviewHighlightStyleSchema.optional(),
    review_preferences: ReviewDisplayPreferencesSchema.optional(),
    page_orientations: ReviewPageOrientationsSchema.optional(),
  })).default({}),
}).transform((settings) => ({ ...settings, version: 3 as const }));
export type AppSettingsFile = z.infer<typeof AppSettingsFileSchema>;

export const ReviewHighlightSettingsResultSchema = z.object({
  global: ReviewHighlightStyleSchema,
  task_override: ReviewHighlightStyleSchema.nullable(),
  effective: ReviewHighlightStyleSchema,
  global_preferences: ReviewDisplayPreferencesSchema,
  task_preferences_override: ReviewDisplayPreferencesSchema.nullable(),
  effective_preferences: ReviewDisplayPreferencesSchema,
  search_script_scope: SearchScriptScopeSchema,
  page_orientations: ReviewPageOrientationsSchema,
  scope: z.enum(["global", "task"]),
});
export type ReviewHighlightSettingsResult = z.infer<typeof ReviewHighlightSettingsResultSchema>;

export const ReviewHighlightSettingsGetParamsSchema = z.object({
  task_id: z.string().min(1).optional(),
});

export const ReviewHighlightSettingsUpdateParamsSchema = z.union([
  z.object({
    scope: z.literal("global"),
    highlight: ReviewHighlightStyleSchema,
    task_id: z.string().min(1).optional(),
  }),
  z.object({
    scope: z.literal("task"),
    task_id: z.string().min(1),
    highlight: ReviewHighlightStyleSchema.nullable(),
  }),
  z.object({
    scope: z.literal("global"),
    preferences: ReviewDisplayPreferencesSchema,
    task_id: z.string().min(1).optional(),
  }),
  z.object({
    scope: z.literal("global"),
    search_script_scope: SearchScriptScopeSchema,
  }),
  z.object({
    scope: z.literal("task"),
    task_id: z.string().min(1),
    preferences: ReviewDisplayPreferencesSchema.nullable(),
  }),
  z.object({
    scope: z.literal("document"),
    task_id: z.string().min(1),
    document_id: z.string().min(1),
    orientation: ReviewPageOrientationSchema,
  }),
]);
export type ReviewHighlightSettingsUpdateParams = z.infer<typeof ReviewHighlightSettingsUpdateParamsSchema>;

export function normalizeSearchText(value: string): string {
  const normalized = value.replace(/^ +| +$/g, "").normalize("NFC");
  if (!normalized) throw new Error("请输入检索文字或词语");
  if (normalized.includes("\uFEFF")) throw new Error("检索词不能包含特殊不可见字符");
  if (/\p{Cs}/u.test(normalized)) throw new Error("检索词不能包含代理项字符");
  if (/\p{Cc}/u.test(normalized)) throw new Error("检索词不能包含控制字符");
  if (Array.from(normalized).length > MAX_SEARCH_TEXT_LENGTH)
    throw new Error(`检索词最多 ${MAX_SEARCH_TEXT_LENGTH} 个字符`);
  return normalized;
}

export const SearchTextSchema = z.string().transform((value, context) => {
  try {
    return normalizeSearchText(value);
  } catch (error) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : "检索词无效" });
    return z.NEVER;
  }
});

const TaskCreateCommonSchema = {
  search_text: SearchTextSchema,
  output_dir: z.string().optional(),
  name: z.string().optional(),
  parallel_workers: z.literal(1).optional(),
  review_preferences: ReviewDisplayPreferencesSchema.optional(),
};

/**
 * 兼容既有 source_dir 调用；source_type="files" 时改用明确的文件清单。
 * 实际路径可读性、去重与上限以 Engine 端校验为准。
 */
export const TaskCreateParamsSchema = z.union([
  z.object({
    ...TaskCreateCommonSchema,
    source_type: z.literal("folder").optional(),
    source_dir: z.string().min(1),
  }),
  z.object({
    ...TaskCreateCommonSchema,
    source_type: z.literal("files"),
    source_files: z.array(z.string().min(1)).min(1).max(MAX_SOURCE_FILES),
  }),
]);

// --------------------------------------------------------------------------- //
// 错误码（与 Python protocol.ErrorCode 一一对应）
// --------------------------------------------------------------------------- //
export const ErrorCodeSchema = z.enum([
  "VALIDATION_ERROR",
  "PATH_NOT_FOUND",
  "PERMISSION_DENIED",
  "DEPENDENCY_MISSING",
  "ENGINE_START_FAILED",
  "ENGINE_CRASHED",
  "IPC_TIMEOUT",
  "TASK_NOT_FOUND",
  "TASK_STATE_CONFLICT",
  "DATABASE_ERROR",
  "EXPORT_FAILED",
  "DISK_SPACE_LOW",
  "UNSUPPORTED_FILE",
  "PROTOCOL_MISMATCH",
  "UNKNOWN_METHOD",
  "UNKNOWN_ERROR",
  "ENGINE_SHUTTING_DOWN",
  "ENGINE_STOPPED",
  "SOURCE_EVIDENCE_UNAVAILABLE",
  "SOURCE_FILE_CHANGED",
  "PAGE_RENDER_LIMIT_EXCEEDED",
  "OCR_CORPUS_UNAVAILABLE",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

// --------------------------------------------------------------------------- //
// 消息骨架
// --------------------------------------------------------------------------- //
export const RequestSchema = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  request_id: z.string().min(1),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
});
export type Request = z.infer<typeof RequestSchema>;

export const ErrorPayloadSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).default({}),
});
export type ErrorPayload = z.infer<typeof ErrorPayloadSchema>;

export const SuccessResponseSchema = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  request_id: z.string(),
  ok: z.literal(true),
  result: z.record(z.string(), z.unknown()).default({}),
});

export const ErrorResponseSchema = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  request_id: z.string().nullable(),
  ok: z.literal(false),
  error: ErrorPayloadSchema,
});

export const ResponseSchema = z.discriminatedUnion("ok", [SuccessResponseSchema, ErrorResponseSchema]);
export type Response = z.infer<typeof ResponseSchema>;

const GenericEventSchema = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  event: z.string(),
  task_id: z.string().nullable().default(null),
  sequence: z.number().int().nonnegative().optional(),
  timestamp: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
}).refine((event) => event.event !== "engine.ready", { message: "engine.ready must use the strict ready schema" });

export const EngineReadyPayloadSchema = z.object({
  engine_version: z.string().min(1),
  protocol_version: z.literal(PROTOCOL_VERSION),
});

export const EngineReadyEventSchema = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  event: z.literal("engine.ready"),
  task_id: z.null(),
  sequence: z.number().int().nonnegative().optional(),
  timestamp: z.string().optional(),
  payload: EngineReadyPayloadSchema,
});

export const EventSchema = z.union([EngineReadyEventSchema, GenericEventSchema]);
export type Event = z.infer<typeof EventSchema>;

/** Python stdout 上的任意一行消息（响应或事件）。 */
export const WireMessageSchema = z.union([ResponseSchema, EventSchema]);

// --------------------------------------------------------------------------- //
// 方法名（Phase 2 仅实现 app.info / diagnostics.run；其余 Phase 3+ 扩展）
// --------------------------------------------------------------------------- //
export const MethodNameSchema = z.enum([
  "app.info",
  "diagnostics.run",
  "tasks.create",
  "tasks.start",
  "tasks.pause",
  "tasks.resume",
  "tasks.cancel",
  "tasks.delete",
  "tasks.cleanupTarget",
  "tasks.list",
  "tasks.get",
  "results.query",
  "results.getDetail",
  "search.corpusStatus",
  "search.execute",
  "search.sessions",
  "search.hits",
  "search.preparePageImage",
  "review.preparePageImage",
  "review.updateDecision",
  "review.updateNote",
  "export.html",
  "export.json",
  "export.review",
  "exports.list",
  "files.openOriginal",
  "files.openFolder",
  "settings.get",
  "settings.update",
]);
export type MethodName = z.infer<typeof MethodNameSchema>;

// --------------------------------------------------------------------------- //
// 结果 schema（已实现的方法）
// --------------------------------------------------------------------------- //
export const BuildMetadataSchema = z.object({
  version: z.string(),
  git_commit: z.string(),
  build_time: z.string(),
  python_version: z.string(),
  node_version: z.string(),
  electron_version: z.string(),
  protocol_version: z.number(),
});
export type BuildMetadata = z.infer<typeof BuildMetadataSchema>;

export const AppInfoResultSchema = z.object({
  engine_version: z.string(),
  protocol_version: z.number(),
  python_executable: z.string(),
  app_version: z.string().optional(),
  build_metadata: BuildMetadataSchema.nullable().optional(),
  desktop_metadata: BuildMetadataSchema.nullable().optional(),
});
export type AppInfoResult = z.infer<typeof AppInfoResultSchema>;

export const CheckStatusSchema = z.enum(["PASS", "WARN", "FAIL"]);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const DiagnosticCheckSchema = z.object({
  key: z.string(),
  label: z.string(),
  status: CheckStatusSchema,
  detail: z.string().default(""),
  impact: z.string().default(""),
  remedy: z.string().default(""),
  extra: z.record(z.string(), z.string()).default({}),
});
export type DiagnosticCheck = z.infer<typeof DiagnosticCheckSchema>;

export const DiagnosticsResultSchema = z.object({
  engine_version: z.string(),
  python_version: z.string(),
  python_executable: z.string(),
  platform: z.string(),
  overall: CheckStatusSchema,
  checks: z.array(DiagnosticCheckSchema),
});
export type DiagnosticsResult = z.infer<typeof DiagnosticsResultSchema>;

export const SearchModeSchema = z.enum(["exact_literal", "legacy_fixed_pair"]);
export const OcrCorpusStatusValueSchema = z.enum([
  "not_built",
  "building",
  "ready",
  "partial",
  "failed",
  "legacy_requires_reocr",
]);

export const TaskFailureSchema = z.object({
  failure_id: z.string().min(1).optional(),
  file_path: z.string().default(""),
  page_number: z.number().int().positive().nullable().default(null),
  stage: z.string().default(""),
  error_type: z.string().default(""),
  error_message: z.string().default(""),
  possible_missed_hits: z.boolean().default(true),
}).passthrough();
export type TaskFailure = z.infer<typeof TaskFailureSchema>;

export const TaskSummarySchema = z.object({
  task_id: z.string().min(1),
  status: z.string().min(1),
  search_text: z.string().min(1),
  search_terms: z.array(z.string().min(1)).min(1),
  search_mode: SearchModeSchema,
  processed_pages: z.number().int().nonnegative(),
  total_pages: z.number().int().nonnegative(),
  occurrence_count: z.number().int().nonnegative(),
  worker_generation: z.number().int().nonnegative(),
  last_event_sequence: z.number().int().nonnegative(),
  source_kind: ScanSourceKindSchema.optional(),
  source_label: z.string().optional(),
  source_files: z.array(z.string()).optional(),
  review_preferences: ReviewDisplayPreferencesSchema.optional(),
  ocr_corpus_version: z.number().int().nonnegative().optional(),
  ocr_index_status: OcrCorpusStatusValueSchema.optional(),
  ocr_model_id: z.string().nullable().optional(),
  ocr_model_sha256: z.string().nullable().optional(),
  ocr_indexed_pages: z.number().int().nonnegative().optional(),
  failures: z.array(TaskFailureSchema).optional(),
  cleanup_status: z.string().nullable().optional(),
  cleanup_error_summary: z.string().nullable().optional(),
}).passthrough();

export const TaskCreateResultSchema = z.object({
  task_id: z.string().min(1),
  status: z.string().min(1),
  source_dir: z.string(),
  source_kind: ScanSourceKindSchema.optional(),
  source_label: z.string().optional(),
  source_files: z.array(z.string()).optional(),
  review_preferences: ReviewDisplayPreferencesSchema.optional(),
  file_count: z.number().int().nonnegative(),
  search_text: z.string().min(1),
  search_terms: z.array(z.string().min(1)).min(1),
  search_mode: SearchModeSchema,
}).passthrough();

export const TaskDeleteResultSchema = z.object({
  task_id: z.string().min(1),
  deleted: z.literal(true),
}).passthrough();

export const TaskCleanupTargetResultSchema = z.object({
  task_id: z.string().min(1),
  path: z.string().nullable(),
}).passthrough();

export const TasksListResultSchema = z.object({
  items: z.array(TaskSummarySchema),
  limit: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

export const ExportRecordSchema = z.object({
  export_id: z.string().min(1),
  task_id: z.string().min(1),
  kind: z.string().min(1),
  path: z.string().min(1),
  created_at: z.string().min(1),
});

export const ExportsListResultSchema = z.object({
  task_id: z.string().min(1),
  items: z.array(ExportRecordSchema),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});

export const ReviewSummarySchema = z.object({
  reviewed_count: z.number().int().nonnegative(),
  unreviewed_count: z.number().int().nonnegative(),
  confirmed_count: z.number().int().nonnegative(),
  needs_review_count: z.number().int().nonnegative(),
  rejected_count: z.number().int().nonnegative(),
});

export const ResultsQueryParamsSchema = z.object({
  task_id: z.string().min(1),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().nonnegative().optional(),
  document: z.string().nullable().optional(),
  status: z.enum(["confirmed", "needs_review", "rejected", "unreviewed"]).nullable().optional(),
  character: z.string().nullable().optional(),
  search: z.string().nullable().optional(),
});

export const ResultsQueryResultSchema = z.object({
  task_id: z.string().min(1),
  total: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(200),
  offset: z.number().int().nonnegative(),
  has_more: z.boolean(),
  review_summary: ReviewSummarySchema,
  task_status: z.string().min(1),
  scan_complete: z.boolean(),
  review_complete: z.boolean(),
  items: z.array(z.record(z.string(), z.unknown())),
});

export const OcrCorpusStatusResultSchema = z.object({
  task_id: z.string().min(1),
  status: OcrCorpusStatusValueSchema,
  corpus_version: z.number().int().nonnegative(),
  model_id: z.string().nullable(),
  model_sha256: z.string().nullable(),
  indexed_pages: z.number().int().nonnegative(),
  line_count: z.number().int().nonnegative(),
  requires_reocr: z.boolean(),
});
export type OcrCorpusStatusResult = z.infer<typeof OcrCorpusStatusResultSchema>;

const OcrSearchFormsSchema = z.object({
  original: z.string(),
  simplified: z.string(),
  traditional: z.string(),
  taiwan: z.string(),
  hong_kong: z.string(),
});

export const OcrSearchQueryGraphSchema = z.object({
  forms: OcrSearchFormsSchema,
  semantic_status: z.enum(["opencc_phrase_confirmed", "glyph_only_unconfirmed"]),
  semantic_label: z.string(),
  opencc_phrase_evidence: z.record(z.string(), z.object({
    phrase_form: z.string(),
    character_form: z.string(),
  })),
  single_character_variants: z.array(z.object({
    text: z.string().min(1),
    simplified: z.string().min(1),
    regions: z.array(z.string()),
    semantic_status: z.literal("glyph_only_unconfirmed"),
    semantic_label: z.string(),
  })),
});
export type OcrSearchQueryGraph = z.infer<typeof OcrSearchQueryGraphSchema>;

export const OcrSearchCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  layers: z.record(z.string(), z.number().int().nonnegative()),
  scripts: z.record(z.string(), z.number().int().nonnegative()),
  verification: z.record(z.string(), z.number().int().nonnegative()),
  candidate_pending_review: z.number().int().nonnegative(),
  corpus_status: OcrCorpusStatusValueSchema,
  corpus_incomplete: z.boolean(),
});
export type OcrSearchCounts = z.infer<typeof OcrSearchCountsSchema>;

export const OcrSearchSessionSchema = z.object({
  search_session_id: z.string().min(1),
  task_id: z.string().min(1),
  query_text: z.string().min(1),
  normalized_query: z.string().min(1),
  script_scope: SearchScriptScopeSchema,
  status: z.literal("completed"),
  corpus_version: z.number().int().positive(),
  query_forms: OcrSearchQueryGraphSchema,
  counts: OcrSearchCountsSchema,
  created_at: z.string().min(1),
  completed_at: z.string().nullable(),
});
export type OcrSearchSession = z.infer<typeof OcrSearchSessionSchema>;

export const OcrSearchExecuteParamsSchema = z.object({
  task_id: z.string().min(1),
  query_text: SearchTextSchema,
  script_scope: SearchScriptScopeSchema.default(DEFAULT_SEARCH_SCRIPT_SCOPE),
});
export type OcrSearchExecuteParams = z.infer<typeof OcrSearchExecuteParamsSchema>;

export const OcrSearchSessionsParamsSchema = z.object({
  task_id: z.string().min(1),
  limit: z.number().int().min(1).max(200).optional(),
});

export const OcrSearchSessionsResultSchema = z.object({
  task_id: z.string().min(1),
  items: z.array(OcrSearchSessionSchema),
});
export type OcrSearchSessionsResult = z.infer<typeof OcrSearchSessionsResultSchema>;

export const OcrSearchHitSchema = z.object({
  search_hit_id: z.string().min(1),
  search_session_id: z.string().min(1),
  task_id: z.string().min(1),
  ocr_line_id: z.string().min(1),
  match_layer: z.enum(["raw_exact", "context_resolved", "variant_graph", "ocr_top_k"]),
  layer_priority: z.number().int().min(1).max(4),
  index_kind: z.string().min(1),
  matched_text: z.string().min(1),
  index_start: z.number().int().nonnegative(),
  index_end: z.number().int().positive(),
  source_start: z.number().int().nonnegative().nullable(),
  source_end: z.number().int().positive().nullable(),
  source_text: z.string(),
  source_script: z.enum(["simplified", "traditional", "neutral", "mixed", "unknown"]),
  verification_status: z.string().min(1),
  confidence: z.number().min(0).max(1),
  payload: z.record(z.string(), z.unknown()),
  document_id: z.string().min(1),
  source_id: z.string().min(1),
  page_no: z.number().int().positive(),
  page_index: z.number().int().nonnegative(),
  line_index: z.number().int().nonnegative(),
  raw_text: z.string(),
  resolved_text: z.string(),
  line_confidence: z.number().min(0).max(1),
  bbox: z.array(z.array(z.number())),
  word_boxes: z.array(z.unknown()),
  isolated_top_k: z.array(z.record(z.string(), z.unknown())),
  match_bbox: z.array(z.array(z.number())),
  source_page_width: z.number().int().nonnegative(),
  source_page_height: z.number().int().nonnegative(),
  display_path: z.string(),
  file_name: z.string(),
  normalized_x0: z.number().min(0).max(1),
  normalized_y0: z.number().min(0).max(1),
  normalized_x1: z.number().min(0).max(1),
  normalized_y1: z.number().min(0).max(1),
}).passthrough();
export type OcrSearchHit = z.infer<typeof OcrSearchHitSchema>;

export const OcrSearchHitsParamsSchema = z.object({
  task_id: z.string().min(1),
  search_session_id: z.string().min(1),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().nonnegative().optional(),
});

export const OcrSearchHitsResultSchema = z.object({
  search_session_id: z.string().min(1),
  task_id: z.string().min(1),
  session: OcrSearchSessionSchema,
  total: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(200),
  offset: z.number().int().nonnegative(),
  has_more: z.boolean(),
  items: z.array(OcrSearchHitSchema),
});
export type OcrSearchHitsResult = z.infer<typeof OcrSearchHitsResultSchema>;

export const OcrSearchPreparePageImageParamsSchema = z.object({
  task_id: z.string().min(1),
  search_hit_id: z.string().min(1),
  target_css_width: z.number().finite().positive(),
  target_css_height: z.number().finite().positive(),
  device_pixel_ratio: z.number().finite().min(0.5).max(4),
});
export type OcrSearchPreparePageImageParams = z.infer<typeof OcrSearchPreparePageImageParamsSchema>;

export const ReviewPreparePageImageParamsSchema = z.object({
  task_id: z.string().min(1),
  occurrence_id: z.string().min(1),
  target_css_width: z.number().finite().positive(),
  target_css_height: z.number().finite().positive(),
  device_pixel_ratio: z.number().finite().min(0.5).max(4),
});
export type ReviewPreparePageImageParams = z.infer<typeof ReviewPreparePageImageParamsSchema>;

export const ReviewPageImageResultSchema = z.object({
  asset_relpath: z.string().min(1),
  asset_version: z.string().min(1),
  pixel_width: z.number().int().positive(),
  pixel_height: z.number().int().positive(),
  width_100_css: z.number().finite().positive(),
  height_100_css: z.number().finite().positive(),
  source_kind: z.enum(["pdf", "raster", "djvu", "demo"]),
  fidelity: z.enum(["verified_source", "generated_demo"]),
  overscale_warning: z.string().nullable(),
});
export type ReviewPageImageResult = z.infer<typeof ReviewPageImageResultSchema>;

export const TaskSearchEventPayloadSchema = z.object({
  search_text: z.string().min(1),
  search_terms: z.array(z.string().min(1)).min(1),
  search_mode: SearchModeSchema,
}).passthrough();

export function parseMethodResult(method: string, value: unknown): unknown {
  if (method === "tasks.create") return TaskCreateResultSchema.parse(value);
  if (method === "tasks.delete") return TaskDeleteResultSchema.parse(value);
  if (method === "tasks.cleanupTarget") return TaskCleanupTargetResultSchema.parse(value);
  if (method === "tasks.get") return TaskSummarySchema.parse(value);
  if (method === "tasks.list") return TasksListResultSchema.parse(value);
  if (method === "exports.list") return ExportsListResultSchema.parse(value);
  if (method === "results.query") return ResultsQueryResultSchema.parse(value);
  if (method === "search.corpusStatus") return OcrCorpusStatusResultSchema.parse(value);
  if (method === "search.execute") return OcrSearchSessionSchema.parse(value);
  if (method === "search.sessions") return OcrSearchSessionsResultSchema.parse(value);
  if (method === "search.hits") return OcrSearchHitsResultSchema.parse(value);
  if (method === "search.preparePageImage") return ReviewPageImageResultSchema.parse(value);
  if (method === "review.preparePageImage") return ReviewPageImageResultSchema.parse(value);
  return value;
}

// --------------------------------------------------------------------------- //
// Renderer 侧统一错误模型（供 UI 展示）
// --------------------------------------------------------------------------- //
export interface UserFacingError {
  code: ErrorCode;
  /** 发生了什么 */
  message: string;
  /** 影响什么 */
  impact?: string;
  /** 用户现在能做什么 */
  remedy?: string;
  /** 技术详情入口 */
  details?: Record<string, unknown>;
}

export { z };
