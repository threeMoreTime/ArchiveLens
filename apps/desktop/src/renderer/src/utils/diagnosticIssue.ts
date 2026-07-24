import { ErrorCodeSchema, type RendererErrorReport } from "@archivelens/ipc-schema";

/**
 * Renderer 侧稳定诊断码（任务 §十一）。
 *
 * 普通页面只向用户展示业务化的“发生了什么/影响/建议/诊断码”，原始技术错误只上报给
 * Main 的 ErrorRegistry，不直接渲染。后端已有稳定错误码时，展示层优先使用后端码。
 */
export const DIAGNOSTIC_CODES = [
  "ENVIRONMENT_CHECK_FAILED",
  "TASK_LIST_LOAD_FAILED",
  "TASK_STATUS_READ_FAILED",
  "TASK_ACTION_FAILED",
  "TASK_SCAN_PARTIAL",
  "NEW_SCAN_PREFLIGHT_FAILED",
  "NEW_SCAN_CREATE_FAILED",
  "SEARCH_DATA_LOAD_FAILED",
  "SEARCH_EXECUTION_FAILED",
  "SEARCH_PAGE_EVIDENCE_FAILED",
  "REVIEW_RESULTS_LOAD_FAILED",
  "REVIEW_ACTION_FAILED",
  "REVIEW_PAGE_EVIDENCE_FAILED",
  "REVIEW_LAYOUT_CONTEXT_FAILED",
  "REVIEW_LAYOUT_REBUILD_FAILED",
  "SETTINGS_LOAD_FAILED",
  "SETTINGS_SAVE_FAILED",
  "LOCAL_DATA_READ_FAILED",
  "LOCAL_DATA_ACTION_FAILED",
  "EXPORT_LOAD_FAILED",
  "EXPORT_JOB_FAILED",
  "EXPORT_CLEANUP_FAILED",
  "EXPORT_ACTION_FAILED",
] as const;
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

export interface DiagnosticIssue {
  /** 稳定诊断码（后端码优先，否则为 UI 诊断码）。 */
  code: string;
  /** 发生了什么。 */
  what: string;
  /** 对当前工作的影响。 */
  impact: string;
  /** 建议操作。 */
  remedy: string;
  /** 原始错误消息，仅用于上报，不渲染。 */
  rawMessage: string;
  /** 原始调用栈，仅用于上报，不渲染。 */
  rawStack?: string;
}

const DEFAULT_COPY: Record<DiagnosticCode, { what: string; impact: string; remedy: string }> = {
  ENVIRONMENT_CHECK_FAILED: { what: "无法完成本地环境检查。", impact: "暂时无法确认识别服务与格式支持是否就绪。", remedy: "请稍后重新检查；若持续失败可重启应用。" },
  TASK_LIST_LOAD_FAILED: { what: "任务列表加载失败。", impact: "暂时看不到已有任务，但任务数据未受影响。", remedy: "请点击重试；若持续失败可重启应用。" },
  TASK_STATUS_READ_FAILED: { what: "读取任务状态失败。", impact: "当前任务进度可能显示不完整。", remedy: "请点击重试。" },
  TASK_ACTION_FAILED: { what: "任务操作未能完成。", impact: "任务当前状态未改变。", remedy: "请稍后重试该操作。" },
  TASK_SCAN_PARTIAL: { what: "部分文件或页面未能完成识别。", impact: "这些页面可能存在漏检，其余结果不受影响。", remedy: "可在失败清单中查看受影响文件并重试。" },
  NEW_SCAN_PREFLIGHT_FAILED: { what: "扫描前检查未通过。", impact: "尚未创建扫描任务。", remedy: "请检查所选来源后重试。" },
  NEW_SCAN_CREATE_FAILED: { what: "创建扫描任务失败。", impact: "任务尚未建立。", remedy: "请稍后重试；原始文件不会被修改。" },
  SEARCH_DATA_LOAD_FAILED: { what: "检索数据加载失败。", impact: "暂时无法展示检索结果。", remedy: "请点击重试。" },
  SEARCH_EXECUTION_FAILED: { what: "检索执行失败。", impact: "本次检索未返回结果。", remedy: "请稍后重试检索。" },
  SEARCH_PAGE_EVIDENCE_FAILED: { what: "出处页图像加载失败。", impact: "暂时无法核对该结果的原图。", remedy: "请点击重试或切换其他结果。" },
  REVIEW_RESULTS_LOAD_FAILED: { what: "校对结果加载失败。", impact: "暂时无法进入或刷新校对结果。", remedy: "请点击重试。" },
  REVIEW_ACTION_FAILED: { what: "校对操作未能保存。", impact: "本次判断或备注可能未生效。", remedy: "请重试；重试前请勿离开当前结果。" },
  REVIEW_PAGE_EVIDENCE_FAILED: { what: "出处页图像加载失败。", impact: "暂时无法核对该结果的原图。", remedy: "请点击重试或切换其他结果。" },
  REVIEW_LAYOUT_CONTEXT_FAILED: { what: "版面上下文加载失败。", impact: "暂时无法展示该结果的上下文结构。", remedy: "请点击重试。" },
  REVIEW_LAYOUT_REBUILD_FAILED: { what: "版面重建未能完成。", impact: "部分结果的上下文可能仍在待确认状态。", remedy: "请稍后重试重建。" },
  SETTINGS_LOAD_FAILED: { what: "设置加载失败。", impact: "暂时无法读取当前偏好，仍可继续使用默认设置。", remedy: "请点击重试。" },
  SETTINGS_SAVE_FAILED: { what: "设置保存失败。", impact: "本次修改可能未生效。", remedy: "请重试保存。" },
  LOCAL_DATA_READ_FAILED: { what: "本地数据占用读取失败。", impact: "暂时无法显示占用统计，数据本身未受影响。", remedy: "请点击刷新重试。" },
  LOCAL_DATA_ACTION_FAILED: { what: "本地数据操作未能完成。", impact: "本次操作未生效，任务数据未受影响。", remedy: "请稍后重试。" },
  EXPORT_LOAD_FAILED: { what: "导出信息加载失败。", impact: "暂时无法查看导出状态。", remedy: "请点击重试。" },
  EXPORT_JOB_FAILED: { what: "导出作业失败。", impact: "本次导出未完成，已有成功导出不受影响。", remedy: "请重试导出。" },
  EXPORT_CLEANUP_FAILED: { what: "导出临时残留清理未完成。", impact: "临时文件可能仍占用磁盘，正式数据不受影响。", remedy: "请稍后重试清理。" },
  EXPORT_ACTION_FAILED: { what: "导出操作未能完成。", impact: "本次操作未生效。", remedy: "请稍后重试。" },
};

const BACKEND_ERROR_CODES: readonly string[] = ErrorCodeSchema.options;

/** 从错误对象或消息中提取已知后端错误码；无法识别时返回 null。 */
export function extractBackendErrorCode(error: unknown): string | null {
  const codeProp = (error as { code?: unknown } | null)?.code;
  if (typeof codeProp === "string" && BACKEND_ERROR_CODES.includes(codeProp)) return codeProp;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  for (const code of BACKEND_ERROR_CODES) {
    if (new RegExp(`\\b${code}\\b`).test(message)) return code;
  }
  return null;
}

export interface DiagnosticIssueOverrides {
  what?: string;
  impact?: string;
  remedy?: string;
  /** 显式指定后端诊断码；优先级高于自动探测。 */
  backendCode?: string;
}

/**
 * 把任意捕获到的错误归一化为业务化诊断问题。
 *
 * 展示码优先取后端稳定码，否则回退到传入的 UI 诊断码；业务文案始终来自 UI 诊断码。
 * 原始消息与调用栈只保留在 rawMessage/rawStack，供上报使用，不参与渲染。
 */
export function toDiagnosticIssue(
  fallback: DiagnosticCode,
  error: unknown,
  overrides: DiagnosticIssueOverrides = {},
): DiagnosticIssue {
  const base = DEFAULT_COPY[fallback];
  const backend = overrides.backendCode ?? extractBackendErrorCode(error);
  return {
    code: backend ?? fallback,
    what: overrides.what ?? base.what,
    impact: overrides.impact ?? base.impact,
    remedy: overrides.remedy ?? base.remedy,
    rawMessage: error instanceof Error ? error.message : typeof error === "string" ? error : "未知错误",
    rawStack: error instanceof Error && error.stack ? error.stack : undefined,
  };
}

/** 将诊断问题转换为向 Main 上报的原始错误载荷。 */
export function toRendererErrorReport(
  operation: string,
  issue: DiagnosticIssue,
  taskId?: string | null,
): RendererErrorReport {
  return {
    operation,
    task_id: taskId ?? null,
    code: issue.code,
    message: issue.rawMessage,
    stack: issue.rawStack ?? null,
  };
}
