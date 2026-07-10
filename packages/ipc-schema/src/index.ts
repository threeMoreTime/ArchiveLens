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

export const TaskCreateParamsSchema = z.object({
  source_dir: z.string().min(1),
  search_text: SearchTextSchema,
  output_dir: z.string().optional(),
  name: z.string().optional(),
  parallel_workers: z.literal(1).optional(),
});

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
  "tasks.list",
  "tasks.get",
  "results.query",
  "results.getDetail",
  "review.updateDecision",
  "review.updateNote",
  "export.html",
  "export.json",
  "export.review",
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
}).passthrough();

export const TaskCreateResultSchema = z.object({
  task_id: z.string().min(1),
  status: z.string().min(1),
  source_dir: z.string(),
  file_count: z.number().int().nonnegative(),
  search_text: z.string().min(1),
  search_terms: z.array(z.string().min(1)).min(1),
  search_mode: SearchModeSchema,
}).passthrough();

export const TasksListResultSchema = z.object({
  items: z.array(TaskSummarySchema),
  limit: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
});

export const TaskSearchEventPayloadSchema = z.object({
  search_text: z.string().min(1),
  search_terms: z.array(z.string().min(1)).min(1),
  search_mode: SearchModeSchema,
}).passthrough();

export function parseMethodResult(method: string, value: unknown): unknown {
  if (method === "tasks.create") return TaskCreateResultSchema.parse(value);
  if (method === "tasks.get") return TaskSummarySchema.parse(value);
  if (method === "tasks.list") return TasksListResultSchema.parse(value);
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
