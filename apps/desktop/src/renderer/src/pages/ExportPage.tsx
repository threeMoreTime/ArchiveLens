import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button, Card, Spinner, Text } from "@fluentui/react-components";
import type { ResultsPage, TaskSummary } from "../../../preload/api";
import { InlineFeedback, LoadingState, PageHeader } from "../components/feedback";

type ExportFormat = "json" | "html";

interface ExportResult {
  format: ExportFormat;
  path: string;
  occurrenceCount: number;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "导出失败，请重试";
}

function taskStatusLabel(status: string) {
  const labels: Record<string, string> = {
    completed: "扫描已完成",
    running: "扫描进行中",
    paused: "任务已暂停",
    recoverable: "任务可恢复",
    failed: "扫描失败",
    cancelled: "任务已取消",
  };
  return (labels[status] ?? status) || "状态未知";
}

/**
 * Task-level export view. Export history is deliberately session-local because
 * the current protocol has no persisted export-history endpoint.
 */
export default function ExportPage() {
  const { taskId } = useParams();
  const nav = useNavigate();
  const [task, setTask] = useState<TaskSummary | null>(null);
  const [summary, setSummary] = useState<ResultsPage | null>(null);
  const [loading, setLoading] = useState(Boolean(taskId));
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    // Export feedback belongs to one task only; never carry it into a new task.
    setResult(null);
    if (!taskId) {
      setTask(null);
      setSummary(null);
      setLoading(false);
      return () => { active = false; };
    }
    setLoading(true);
    setError("");
    Promise.all([
      window.archiveLens.tasks.get(taskId),
      window.archiveLens.results.query({ task_id: taskId, limit: 1, offset: 0 }),
    ]).then(([nextTask, nextSummary]) => {
      if (!active) return;
      setTask(nextTask);
      setSummary(nextSummary);
    }).catch((nextError: unknown) => {
      if (active) setError(errorMessage(nextError));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [taskId]);

  const runExport = async (format: ExportFormat) => {
    if (!taskId || !summary || exporting) return;
    const incomplete = !summary.scan_complete || !summary.review_complete;
    if (incomplete) {
      const detail = !summary.scan_complete
        ? "扫描尚未完成，导出的是当前数据库快照，结果仍可能增加。"
        : `尚有 ${summary.review_summary.unreviewed_count} 条结果未校对。`;
      if (!window.confirm(`${detail}\n导出文件会保留完整性状态。是否继续？`)) return;
    }
    setExporting(format);
    setError("");
    try {
      const exported = format === "json"
        ? await window.archiveLens.export.json(taskId)
        : await window.archiveLens.export.html(taskId);
      setResult({ format, path: exported.path, occurrenceCount: exported.occurrence_count });
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setExporting(null);
    }
  };

  const openFolder = async () => {
    if (!result) return;
    const directory = result.path.replace(/[/\\][^/\\]+$/, "");
    try {
      await window.archiveLens.files.openFolder(directory);
    } catch (nextError) {
      setError(`无法打开导出目录：${errorMessage(nextError)}`);
    }
  };

  if (!taskId) {
    return (
      <div className="al-welcome">
        <PageHeader title="导出结果" description="从已完成的任务导出完整 OCR 结果与人工校对状态。" />
        <Card className="al-card al-export-empty-card">
          <Text weight="semibold">尚未选择任务</Text>
          <Text className="al-muted">导出始终读取任务的全部数据库结果，不受校对页当前分页影响。</Text>
          <Button appearance="primary" onClick={() => nav("/scan/new")}>新建扫描</Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="al-welcome al-export-page">
      <PageHeader title="导出结果" description="导出任务的全部命中、校对决定和完整性状态，适用于归档、复核或后续数据处理。" />
      {loading && <LoadingState label="正在读取导出摘要…" />}
      {error && <InlineFeedback>{error}</InlineFeedback>}
      {!loading && task && summary && (
        <div className="al-export-layout">
          <div className="al-export-main">
            <Card className="al-card al-export-task-card">
              <div className="al-task-heading"><Text weight="semibold" size={500}>{task.name || "扫描任务"}</Text><span className={`al-badge al-badge-${summary.scan_complete ? "PASS" : "WARN"}`}>{taskStatusLabel(task.status)}</span></div>
              <div className="al-export-task-grid">
                <span>检索词<strong>{task.search_text || "未提供"}</strong></span>
                <span>任务来源<strong title={task.source_dir}>{task.source_dir}</strong></span>
                <span>结果总数<strong>{summary.total} 条</strong></span>
                <span>已校对<strong>{summary.review_summary.reviewed_count} 条</strong></span>
              </div>
            </Card>

            <Card className="al-card">
              <Text weight="semibold">1. 导出范围</Text>
              <Text className="al-muted">将导出该任务的全部 {summary.total} 条结果，而非当前校对页或已加载的项目。</Text>
            </Card>
            <Card className="al-card">
              <Text weight="semibold">2. 选择格式</Text>
              <div className="al-export-format-grid">
                <button className="al-export-format" type="button" onClick={() => void runExport("json")} disabled={Boolean(exporting)} aria-label="导出完整 JSON 数据">
                  <strong>JSON 数据包</strong><span>适合归档、数据处理和系统对接。</span>
                </button>
                <button className="al-export-format" type="button" onClick={() => void runExport("html")} disabled={Boolean(exporting)} aria-label="导出 HTML 审阅报告">
                  <strong>HTML 审阅报告</strong><span>适合浏览、人工复核与本地分享。</span>
                </button>
              </div>
              <div className="al-welcome-actions">
                <Button appearance="primary" disabled={Boolean(exporting)} onClick={() => void runExport("html")}>{exporting === "html" ? <><Spinner size="tiny" /> 正在导出 HTML…</> : "导出 HTML 报告"}</Button>
                <Button disabled={Boolean(exporting)} onClick={() => void runExport("json")}>{exporting === "json" ? <><Spinner size="tiny" /> 正在导出 JSON…</> : "导出 JSON 数据"}</Button>
              </div>
            </Card>
            {result && <InlineFeedback tone="info">已导出 {result.occurrenceCount} 条结果至 {result.path} <Button size="small" onClick={() => void openFolder()}>打开文件夹</Button></InlineFeedback>}
          </div>

          <aside className="al-export-aside" aria-label="导出完整性摘要">
            <Card className="al-card"><Text weight="semibold">导出完整性</Text><div className="al-export-integrity"><span>扫描：{summary.scan_complete ? "已完成" : "尚未完成"}</span><span>校对：{summary.review_complete ? "已完成" : `未完成（剩余 ${summary.review_summary.unreviewed_count} 条）`}</span><span>导出：{result ? "本会话已完成" : "尚未执行"}</span></div></Card>
            {!summary.review_complete && <InlineFeedback tone="warning">当前报告会明确标记为未完成校对，不应作为最终校对报告。</InlineFeedback>}
            <Card className="al-card"><Text weight="semibold">最近导出</Text><Text className="al-muted">当前版本不保存导出历史。本会话最近一次导出会显示在此页。</Text>{result && <Text className="al-export-path" title={result.path}>{result.path}</Text>}</Card>
            <Card className="al-card"><Text weight="semibold">本地处理</Text><Text className="al-muted">所有文件在本机生成和保存，不会上传到网络服务。</Text></Card>
          </aside>
        </div>
      )}
    </div>
  );
}
