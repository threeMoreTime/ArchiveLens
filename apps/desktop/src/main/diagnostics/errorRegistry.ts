import {
  KnownErrorSnapshotSchema,
  MAX_RENDERER_ERROR_DETAILS_CHARS,
  MAX_RENDERER_ERROR_MESSAGE_CHARS,
  MAX_RENDERER_ERROR_STACK_CHARS,
  type KnownErrorSnapshot,
  type RendererErrorReport,
} from "@shared/index";

/**
 * Renderer 上报正文超出长度上限时使用的错误码。
 *
 * 属于 Electron 本地边界，不进入 Python `ErrorCode` 闭合枚举，也不影响 PROTOCOL_VERSION。
 */
export const DIAGNOSTIC_PAYLOAD_TOO_LARGE = "DIAGNOSTIC_PAYLOAD_TOO_LARGE";

export class DiagnosticPayloadTooLargeError extends Error {
  readonly code = DIAGNOSTIC_PAYLOAD_TOO_LARGE;
  constructor(message = "诊断上报内容超出长度上限，已拒绝写入（未静默截断）") {
    super(message);
    this.name = "DiagnosticPayloadTooLargeError";
  }
}

export interface RecordErrorInput {
  source: KnownErrorSnapshot["source"];
  operation: string;
  taskId?: string | null;
  code?: string;
  message: string;
  details?: Record<string, unknown>;
  stack?: string | null;
}

/**
 * 最近一次已知错误登记表（任务 §五）。
 *
 * 只在内存中保存最近一条错误，不落盘、不含日志正文。开发者页面据此展示
 * 与任务相关的最近失败，普通页面不消费本登记表。
 */
export class ErrorRegistry {
  private last: KnownErrorSnapshot | null = null;

  record(input: RecordErrorInput): KnownErrorSnapshot {
    const snapshot = KnownErrorSnapshotSchema.parse({
      time: new Date().toISOString(),
      source: input.source,
      operation: input.operation,
      task_id: input.taskId ?? null,
      code: input.code ?? "UNKNOWN_ERROR",
      message: input.message,
      details: input.details ?? {},
      stack: input.stack ?? null,
    });
    this.last = snapshot;
    return snapshot;
  }

  /**
   * 记录 Renderer 上报错误。任一正文超限即拒绝并抛
   * {@link DiagnosticPayloadTooLargeError}，绝不静默截断。
   */
  recordRendererReport(report: RendererErrorReport): KnownErrorSnapshot {
    if (report.message.length > MAX_RENDERER_ERROR_MESSAGE_CHARS) {
      throw new DiagnosticPayloadTooLargeError();
    }
    if (report.stack && report.stack.length > MAX_RENDERER_ERROR_STACK_CHARS) {
      throw new DiagnosticPayloadTooLargeError();
    }
    if (report.details && JSON.stringify(report.details).length > MAX_RENDERER_ERROR_DETAILS_CHARS) {
      throw new DiagnosticPayloadTooLargeError();
    }
    return this.record({
      source: "renderer",
      operation: report.operation,
      taskId: report.task_id ?? null,
      code: report.code ?? "RENDERER_ERROR",
      message: report.message,
      details: report.details ?? {},
      stack: report.stack ?? null,
    });
  }

  snapshot(): KnownErrorSnapshot | null {
    return this.last;
  }

  /** 仅当最近一条错误确实属于该任务时返回，否则返回 null。 */
  snapshotForTask(taskId: string): KnownErrorSnapshot | null {
    return this.last && this.last.task_id === taskId ? this.last : null;
  }

  clear(): void {
    this.last = null;
  }
}

/** 全局单例：Main 各处（含 Sidecar 管理器）共享同一份最近错误登记表。 */
export const errorRegistry = new ErrorRegistry();
