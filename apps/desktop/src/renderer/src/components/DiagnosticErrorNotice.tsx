import { useEffect, useState } from "react";
import { Button, Text } from "@fluentui/react-components";
import { toRendererErrorReport, type DiagnosticIssue } from "../utils/diagnosticIssue";

interface DiagnosticErrorNoticeProps {
  issue: DiagnosticIssue;
  /** 上报给 ErrorRegistry 的操作名（如 "tasks.list"）。 */
  operation: string;
  taskId?: string | null;
  onRetry?: () => void;
  tone?: "error" | "warning";
}

/**
 * 统一普通错误提示（任务 §十一）。
 *
 * 只渲染业务化的“发生了什么/影响/建议/诊断码”，并提供重试与“复制诊断摘要”。
 * 原始技术错误只在挂载时上报给 Main 的 ErrorRegistry，绝不渲染。
 */
export function DiagnosticErrorNotice({
  issue,
  operation,
  taskId = null,
  onRetry,
  tone = "error",
}: DiagnosticErrorNoticeProps) {
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    window.archiveLens.app
      .reportRendererError(toRendererErrorReport(operation, issue, taskId))
      .catch(() => undefined);
    // 仅在真实错误内容或操作变化时重新上报，避免重复渲染触发多次上报。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operation, taskId, issue.code, issue.rawMessage]);

  const copySummary = async () => {
    setFeedback("");
    try {
      const result = await window.archiveLens.app.copyDiagnosticSummary({
        task_id: taskId ?? undefined,
        mode: "redacted",
        current_error: { code: issue.code, task_id: taskId },
      });
      setFeedback(`已复制脱敏诊断摘要（${result.char_count} 字符）到本机剪贴板`);
    } catch {
      setFeedback("复制诊断摘要失败，请稍后重试");
    }
  };

  return (
    <div className={`al-diagnostic-notice al-diagnostic-notice-${tone}`} role="alert">
      <div className="al-diagnostic-notice-head">
        <Text weight="semibold">{issue.what}</Text>
        <span className="al-diagnostic-code">诊断码 {issue.code}</span>
      </div>
      <Text className="al-muted">影响：{issue.impact}</Text>
      <Text className="al-muted">建议：{issue.remedy}</Text>
      <div className="al-inline-actions">
        {onRetry && <Button size="small" appearance="primary" onClick={onRetry}>重试</Button>}
        <Button size="small" onClick={() => void copySummary()}>复制诊断摘要</Button>
      </div>
      {feedback && <Text className="al-muted" role="status">{feedback}</Text>}
    </div>
  );
}
