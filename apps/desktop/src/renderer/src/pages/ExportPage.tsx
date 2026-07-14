import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button, Card, Spinner, Text } from "@fluentui/react-components";
import type { ExportRecord, ResultsPage, TaskSummary } from "../../../preload/api";
import { InlineFeedback, LoadingState, PageHeader } from "../components/feedback";
import { formatDateTime, taskDisplayName, taskSourceLabel, taskStatusView } from "../utils/presentation";

type ExportFormat = "json" | "html";

interface ExportResult {
  format: ExportFormat;
  path: string;
  occurrenceCount: number;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "导出失败，请重试";
}

function exportKindLabel(kind: string): string {
  if (kind === "html") return "HTML 审阅报告";
  if (kind === "json") return "JSON 数据包";
  if (kind === "review") return "校对记录";
  return kind.toUpperCase();
}

export default function ExportPage() {
  const { taskId } = useParams();
  const nav = useNavigate();
  const [task, setTask] = useState<TaskSummary | null>(null);
  const [summary, setSummary] = useState<ResultsPage | null>(null);
  const [history, setHistory] = useState<ExportRecord[]>([]);
  const [loading, setLoading] = useState(Boolean(taskId));
  const [selectedFormat, setSelectedFormat] = useState<ExportFormat>("html");
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let active = true;
    setTask(null);
    setSummary(null);
    setHistory([]);
    setResult(null);
    setAwaitingConfirmation(false);
    setSelectedFormat("html");
    if (!taskId) {
      setTask(null);
      setSummary(null);
      setHistory([]);
      setLoading(false);
      return () => { active = false; };
    }
    setLoading(true);
    setError("");
    Promise.all([
      window.archiveLens.tasks.get(taskId),
      window.archiveLens.results.query({ task_id: taskId, limit: 1, offset: 0 }),
      window.archiveLens.export.list(taskId, { limit: 10, offset: 0 }),
    ]).then(([nextTask, nextSummary, exports]) => {
      if (!active) return;
      setTask(nextTask);
      setSummary(nextSummary);
      setHistory(exports.items);
    }).catch((nextError: unknown) => {
      if (active) setError(errorMessage(nextError));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [reloadToken, taskId]);

  const performExport = async (format: ExportFormat) => {
    if (!taskId || !summary || exporting) return;
    setAwaitingConfirmation(false);
    setExporting(format);
    setError("");
    try {
      const exported = format === "json"
        ? await window.archiveLens.export.json(taskId)
        : await window.archiveLens.export.html(taskId);
      setResult({ format, path: exported.path, occurrenceCount: exported.occurrence_count });
      try {
        const exports = await window.archiveLens.export.list(taskId, { limit: 10, offset: 0 });
        setHistory(exports.items);
      } catch (historyError) {
        setError(`导出已完成，但历史记录刷新失败：${errorMessage(historyError)}。重新加载此页即可再次读取。`);
      }
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setExporting(null);
    }
  };

  const requestExport = () => {
    if (!summary || exporting) return;
    if (!summary.scan_complete || !summary.review_complete) {
      setAwaitingConfirmation(true);
      return;
    }
    void performExport(selectedFormat);
  };

  const openFolderFor = async (path: string) => {
    const directory = path.replace(/[/\\][^/\\]+$/, "");
    try {
      await window.archiveLens.files.openFolder(directory);
    } catch (nextError) {
      setError(`无法打开导出目录：${errorMessage(nextError)}`);
    }
  };

  const openTaskFolder = async () => {
    if (!task?.workspace_dir) return;
    try {
      await window.archiveLens.files.openFolder(task.workspace_dir);
    } catch (nextError) {
      setError(`无法打开任务目录：${errorMessage(nextError)}`);
    }
  };

  if (!taskId) {
    return (
      <div className="al-welcome">
        <PageHeader title="导出结果" description="从任务中心选择一项任务，再导出该任务的完整 OCR 和校对结果。" />
        <Card className="al-card al-export-empty-card">
          <Text weight="semibold">尚未选择任务</Text>
          <Text className="al-muted">导出始终读取任务的全部数据库结果，不受校对页当前分页影响。</Text>
          <Button appearance="primary" onClick={() => nav("/tasks")}>前往任务中心</Button>
        </Card>
      </div>
    );
  }

  const statusView = task ? taskStatusView(task) : null;
  const incompleteReason = !summary?.scan_complete
    ? task?.failure_count
      ? `任务有 ${task.failure_count} 项处理失败，报告可能缺页。`
      : "扫描尚未完成，导出的是当前数据库快照，结果仍可能增加。"
    : summary && !summary.review_complete
      ? `尚有 ${summary.review_summary.unreviewed_count} 条结果未校对。`
      : "";

  return (
    <div className="al-welcome al-export-page">
      <PageHeader title="导出结果" description="选择一种格式，然后一次性导出该任务的全部命中、校对决定和完整性状态。" />
      {loading && <LoadingState label="正在读取导出摘要和历史记录…" />}
      {error && <InlineFeedback>{error} {!task && <Button size="small" onClick={() => setReloadToken((value) => value + 1)}>重试读取</Button>}</InlineFeedback>}
      {!loading && task && summary && statusView && (
        <div className="al-export-layout">
          <div className="al-export-main">
            <Card className="al-card al-export-task-card">
              <div className="al-task-heading"><Text weight="semibold" size={500}>{taskDisplayName(task)}</Text><span className={`al-badge al-badge-${statusView.tone}`}>{statusView.label}</span></div>
              <div className="al-export-task-grid"><span>检索词<strong>{task.search_text || "未提供"}</strong></span><span>任务来源<strong title={task.source_dir}>{taskSourceLabel(task)}</strong></span><span>结果总数<strong>{summary.total} 条</strong></span><span>已校对<strong>{summary.review_summary.reviewed_count} 条</strong></span></div>
            </Card>

            <Card className="al-card"><Text weight="semibold">1. 确认导出范围</Text><Text className="al-muted">将导出该任务的全部 {summary.total} 条结果，而非当前校对页或已加载的项目。</Text></Card>
            <Card className="al-card">
              <Text weight="semibold">2. 选择格式</Text>
              <div className="al-export-format-grid" role="radiogroup" aria-label="导出格式">
                <button className={`al-export-format ${selectedFormat === "json" ? "selected" : ""}`} type="button" role="radio" aria-checked={selectedFormat === "json"} onClick={() => { setSelectedFormat("json"); setAwaitingConfirmation(false); }} disabled={Boolean(exporting)}><strong>JSON 数据包</strong><span>适合归档、数据处理和系统对接。</span></button>
                <button className={`al-export-format ${selectedFormat === "html" ? "selected" : ""}`} type="button" role="radio" aria-checked={selectedFormat === "html"} onClick={() => { setSelectedFormat("html"); setAwaitingConfirmation(false); }} disabled={Boolean(exporting)}><strong>HTML 审阅报告</strong><span>适合浏览、人工复核与本地分享。</span></button>
              </div>
              <div className="al-export-primary-action"><Button appearance="primary" size="large" disabled={Boolean(exporting)} onClick={requestExport}>{exporting ? <><Spinner size="tiny" /> 正在导出 {exporting.toUpperCase()}…</> : `导出 ${selectedFormat.toUpperCase()}`}</Button></div>
            </Card>

            {awaitingConfirmation && <InlineFeedback tone="warning"><strong>当前导出不是最终完整结果。</strong> {incompleteReason} 导出文件会明确保留完整性状态。<div className="al-inline-actions"><Button appearance="primary" size="small" onClick={() => void performExport(selectedFormat)}>仍然导出阶段性结果</Button><Button size="small" onClick={() => setAwaitingConfirmation(false)}>返回检查</Button></div></InlineFeedback>}
            {result && <InlineFeedback tone="info">已导出 {result.occurrenceCount} 条结果至 {result.path} <Button size="small" onClick={() => void openFolderFor(result.path)}>打开文件夹</Button></InlineFeedback>}
          </div>

          <aside className="al-export-aside" aria-label="导出完整性摘要">
            <Card className="al-card"><Text weight="semibold">导出完整性</Text><div className="al-export-integrity"><span>扫描：{summary.scan_complete ? "已完整处理" : "未完整处理"}</span><span>校对：{summary.review_complete ? "已完成" : `未完成（剩余 ${summary.review_summary.unreviewed_count} 条）`}</span><span>本次导出：{result ? "已完成" : "尚未执行"}</span></div></Card>
            {(!summary.scan_complete || !summary.review_complete) && <InlineFeedback tone="warning">阶段性报告不应作为最终核验报告；请在扫描无失败且全部结果校对后重新导出。</InlineFeedback>}
            <Card className="al-card"><div className="al-card-heading-row"><Text weight="semibold">最近导出</Text><Button appearance="subtle" size="small" onClick={() => void openTaskFolder()}>任务目录</Button></div>{history.length === 0 ? <Text className="al-muted">此任务尚无导出记录。</Text> : <div className="al-export-history">{history.map((item) => <button key={item.export_id} type="button" onClick={() => void openFolderFor(item.path)}><strong>{exportKindLabel(item.kind)}</strong><span>{formatDateTime(item.created_at)}</span><small title={item.path}>{item.path}</small></button>)}</div>}</Card>
            <Card className="al-card"><Text weight="semibold">本地处理</Text><Text className="al-muted">导出文件与历史记录均保存在当前任务工作区，不会上传到网络服务。</Text></Card>
          </aside>
        </div>
      )}
    </div>
  );
}
