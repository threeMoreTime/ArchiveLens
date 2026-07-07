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
export const PROTOCOL_VERSION = 1 as const;

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

export const EventSchema = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  event: z.string(),
  task_id: z.string().nullable().default(null),
  payload: z.record(z.string(), z.unknown()).default({}),
});
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
export const AppInfoResultSchema = z.object({
  engine_version: z.string(),
  protocol_version: z.number(),
  python_executable: z.string(),
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
