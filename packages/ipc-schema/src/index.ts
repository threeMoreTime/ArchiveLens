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

export const AppSettingsFileSchema = z.object({
  version: z.literal(1).default(1),
  appearance: z.object({
    review_highlight: ReviewHighlightStyleSchema.default(DEFAULT_REVIEW_HIGHLIGHT_STYLE),
  }).default({ review_highlight: DEFAULT_REVIEW_HIGHLIGHT_STYLE }),
  task_overrides: z.record(z.string().min(1), z.object({
    review_highlight: ReviewHighlightStyleSchema,
  })).default({}),
});
export type AppSettingsFile = z.infer<typeof AppSettingsFileSchema>;

export const ReviewHighlightSettingsResultSchema = z.object({
  global: ReviewHighlightStyleSchema,
  task_override: ReviewHighlightStyleSchema.nullable(),
  effective: ReviewHighlightStyleSchema,
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
  "tasks.list",
  "tasks.get",
  "results.query",
  "results.getDetail",
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
  failures: z.array(TaskFailureSchema).optional(),
}).passthrough();

export const TaskCreateResultSchema = z.object({
  task_id: z.string().min(1),
  status: z.string().min(1),
  source_dir: z.string(),
  source_kind: ScanSourceKindSchema.optional(),
  source_label: z.string().optional(),
  source_files: z.array(z.string()).optional(),
  file_count: z.number().int().nonnegative(),
  search_text: z.string().min(1),
  search_terms: z.array(z.string().min(1)).min(1),
  search_mode: SearchModeSchema,
}).passthrough();

export const TaskDeleteResultSchema = z.object({
  task_id: z.string().min(1),
  deleted: z.literal(true),
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

export const TaskSearchEventPayloadSchema = z.object({
  search_text: z.string().min(1),
  search_terms: z.array(z.string().min(1)).min(1),
  search_mode: SearchModeSchema,
}).passthrough();

export function parseMethodResult(method: string, value: unknown): unknown {
  if (method === "tasks.create") return TaskCreateResultSchema.parse(value);
  if (method === "tasks.delete") return TaskDeleteResultSchema.parse(value);
  if (method === "tasks.get") return TaskSummarySchema.parse(value);
  if (method === "tasks.list") return TasksListResultSchema.parse(value);
  if (method === "exports.list") return ExportsListResultSchema.parse(value);
  if (method === "results.query") return ResultsQueryResultSchema.parse(value);
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
