import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button, Card, Spinner, Text } from "@fluentui/react-components";
import type { ExportJob, ExportJobStatus, ExportRecord, ResultsPage, TaskSummary } from "../../../preload/api";
import { InlineFeedback, LoadingState, PageHeader } from "../components/feedback";
import { formatDateTime, taskDisplayName, taskSourceLabel, taskStatusView } from "../utils/presentation";

type ExportFormat = "json" | "html";

const TERMINAL_JOB: ReadonlySet<ExportJobStatus> = new Set(["completed", "failed", "cancelled", "interrupted"]);
const ACTIVE_JOB: ReadonlySet<ExportJobStatus> = new Set(["queued", "preparing", "rendering_images", "building", "writing", "cancelling"]);

function isTerminal(status: ExportJobStatus): boolean {
  return TERMINAL_JOB.has(status);
}

function stageLabel(job: ExportJob): string {
  switch (job.current_stage || job.status) {
    case "queued": return "排队中…";
    case "preparing": return "正在准备…";
    case "rendering_images":
    case "images": return `正在处理页面图片 ${job.progress_completed}/${job.progress_total}…`;
    case "building": return "正在组装报告…";
    case "writing": return "正在写入文件…";
    case "cancelling": return "正在取消…";
    case "cancelled": return "已取消";
    case "completed": return "已完成";
    case "failed": return "失败";
    case "interrupted": return "上次未完成（已中断）";
    default: return job.status;
  }
}

function jobTone(status: ExportJobStatus): "PASS" | "WARN" | "FAIL" {
  if (status === "completed") return "PASS";
  if (status === "failed" || status === "interrupted") return "FAIL";
  return "WARN";
}

function exportKindLabel(format: string): string {
  if (format === "html") return "HTML 审阅报告";
  if (format === "json") return "JSON 数据包";
  if (format === "review") return "校对记录";
  return format.toUpperCase();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "导出失败，请重试";
}

export default function ExportPage() {
  const { taskId } = useParams();
  const nav = useNavigate();
  const [task, setTask] = useState<TaskSummary | null>(null);
  const [summary, setSummary] = useState<ResultsPage | null>(null);
  const [history, setHistory] = useState<ExportRecord[]>([]);
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [loading, setLoading] = useState(Boolean(taskId));
  const [selectedFormat, setSelectedFormat] = useState<ExportFormat>("html");
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const loadSeq = useRef(0);

  const loadJobs = useCallback(async (id: string) => {
    try {
      const result = await window.archiveLens.export.listJobs(id);
      setJobs(result.items);
    } catch {
      // 作业列表读取失败不阻塞主流程；下次轮询/事件再刷新
    }
  }, []);

  useEffect(() => {
    const seq = ++loadSeq.current;
    setTask(null);
    setSummary(null);
    setHistory([]);
    setJobs([]);
    setAwaitingConfirmation(false);
    setActionError("");
    setSelectedFormat("html");
    if (!taskId) {
      setLoading(false);
      return () => { loadSeq.current += 1; };
    }
    setLoading(true);
    Promise.all([
      window.archiveLens.tasks.get(taskId),
      window.archiveLens.results.query({ task_id: taskId, limit: 1, offset: 0 }),
      window.archiveLens.export.list(taskId, { limit: 10, offset: 0 }),
      window.archiveLens.export.listJobs(taskId),
    ]).then(([nextTask, nextSummary, exports, jobList]) => {
      if (seq !== loadSeq.current) return;
      setTask(nextTask);
      setSummary(nextSummary);
      setHistory(exports.items);
      setJobs(jobList.items);
    }).catch((nextError: unknown) => {
      if (seq === loadSeq.current) setActionError(errorMessage(nextError));
    }).finally(() => {
      if (seq === loadSeq.current) setLoading(false);
    });
    return () => { loadSeq.current += 1; };
  }, [reloadToken, taskId, loadJobs]);

  // 有运行中作业时轮询；事件触发即时刷新
  const hasActive = jobs.some((job) => ACTIVE_JOB.has(job.status));
  useEffect(() => {
    if (!taskId || !hasActive) return;
    const timer = window.setInterval(() => { void loadJobs(taskId); }, 1000);
    return () => window.clearInterval(timer);
  }, [hasActive, taskId, loadJobs]);

  useEffect(() => {
    if (!taskId) return;
    return window.archiveLens.subscribe.onEvent((event: { task_id?: string | null; event: string }) => {
      if (event.task_id === taskId && event.event === "export.progress") {
        void loadJobs(taskId);
      }
    });
  }, [taskId, loadJobs]);

  const cleanupActive = Boolean(task?.cleanup_status);

  const startExport = async (format: ExportFormat) => {
    if (!taskId || busy) return;
    setAwaitingConfirmation(false);
    setBusy(true);
    setActionError("");
    try {
      await window.archiveLens.export.create({ task_id: taskId, format });
      await loadJobs(taskId);
    } catch (nextError) {
      setActionError(errorMessage(nextError));
    } finally {
      setBusy(false);
    }
  };

  const requestExport = () => {
    if (busy || !summary) return;
    if (selectedFormat === "html" || !summary.scan_complete || !summary.review_complete) {
      setAwaitingConfirmation(true);
      return;
    }
    void startExport(selectedFormat);
  };

  const cancelJob = async (exportId: string) => {
    if (busy) return;
    setBusy(true);
    setActionError("");
    try {
      await window.archiveLens.export.cancel(exportId);
      await loadJobs(taskId ?? "");
    } catch (nextError) {
      setActionError(`取消失败：${errorMessage(nextError)}`);
    } finally {
      setBusy(false);
    }
  };

  const retryJob = async (exportId: string) => {
    if (busy) return;
    setBusy(true);
    setActionError("");
    try {
      await window.archiveLens.export.retry(exportId);
      await loadJobs(taskId ?? "");
    } catch (nextError) {
      setActionError(`重新导出失败：${errorMessage(nextError)}`);
    } finally {
      setBusy(false);
    }
  };

  const openFolderFor = async (path: string) => {
    const directory = path.replace(/[/\\][^/\\]+$/, "");
    try {
      await window.archiveLens.files.openFolder(directory);
    } catch (nextError) {
      setActionError(`无法打开导出目录：${errorMessage(nextError)}`);
    }
  };

  const openTaskFolder = async () => {
    if (!task?.workspace_dir) return;
    try {
      await window.archiveLens.files.openFolder(task.workspace_dir);
    } catch (nextError) {
      setActionError(`无法打开任务目录：${errorMessage(nextError)}`);
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
  const activeJob = jobs.find((job) => ACTIVE_JOB.has(job.status)) ?? null;
  const formatBusy = (fmt: string) => jobs.some((job) => job.format === fmt && ACTIVE_JOB.has(job.status));
  const incompleteReason = !summary?.scan_complete
    ? task?.failure_count
      ? `任务有 ${task.failure_count} 项处理失败，报告可能缺页。`
      : "扫描尚未完成，导出的是当前数据库快照，结果仍可能增加。"
    : summary && !summary.review_complete
      ? `尚有 ${summary.review_summary.unreviewed_count} 条结果未校对。`
      : "";

  return (
    <div className="al-welcome al-export-page">
      <PageHeader title="导出结果" description="选择一种格式，导出在后台进行；可查看进度、取消并重新导出。" />
      {loading && <LoadingState label="正在读取导出摘要和历史记录…" />}
      {actionError && <InlineFeedback tone="error">{actionError}</InlineFeedback>}
      {!loading && !task && <InlineFeedback>读取任务失败 <Button size="small" onClick={() => setReloadToken((value) => value + 1)}>重试读取</Button></InlineFeedback>}
      {!loading && task && summary && statusView && (
        <div className="al-export-layout">
          <div className="al-export-main">
            <Card className="al-card al-export-task-card">
              <div className="al-task-heading"><Text weight="semibold" size={500}>{taskDisplayName(task)}</Text><span className={`al-badge al-badge-${statusView.tone}`}>{statusView.label}</span></div>
              <div className="al-export-task-grid"><span>检索词<strong>{task.search_text || "未提供"}</strong></span><span>任务来源<strong title={task.source_dir}>{taskSourceLabel(task)}</strong></span><span>结果总数<strong>{summary.total} 条</strong></span><span>已校对<strong>{summary.review_summary.reviewed_count} 条</strong></span></div>
            </Card>

            <Card className="al-card"><Text weight="semibold">1. 确认导出范围</Text><Text className="al-muted">将导出该任务的全部 {summary.total} 条结果，而非当前校对页或已加载的项目。</Text></Card>
            <Card className="al-card">
              <Text weight="semibold">2. 选择格式并开始后台导出</Text>
              <div className="al-export-format-grid" role="radiogroup" aria-label="导出格式">
                <button className={`al-export-format ${selectedFormat === "json" ? "selected" : ""}`} type="button" role="radio" aria-checked={selectedFormat === "json"} onClick={() => { setSelectedFormat("json"); setAwaitingConfirmation(false); }} disabled={busy || cleanupActive}><strong>JSON 数据包</strong><span>适合归档、数据处理和系统对接。</span></button>
                <button className={`al-export-format ${selectedFormat === "html" ? "selected" : ""}`} type="button" role="radio" aria-checked={selectedFormat === "html"} onClick={() => { setSelectedFormat("html"); setAwaitingConfirmation(false); }} disabled={busy || cleanupActive}><strong>HTML 审阅报告</strong><span>包含命中页整页图片，适合离线浏览、人工复核、分享与 A4 打印。</span></button>
              </div>
              <div className="al-export-primary-action">
                <Button appearance="primary" size="large" disabled={busy || cleanupActive || formatBusy(selectedFormat)} onClick={requestExport}>
                  {formatBusy(selectedFormat) ? <><Spinner size="tiny" /> 该格式正在导出…</> : `开始导出 ${selectedFormat.toUpperCase()}`}
                </Button>
              </div>
              {cleanupActive && <InlineFeedback tone="warning">任务正在删除，无法导出。请先在任务中心完成清理。</InlineFeedback>}
            </Card>

            {awaitingConfirmation && <InlineFeedback tone="warning">
              {(!summary.scan_complete || !summary.review_complete) && <><strong>当前导出不是最终完整结果。</strong> {incompleteReason} 导出文件会明确保留完整性状态。 </>}
              {selectedFormat === "html" && <><strong>HTML 报告将嵌入全部命中页面图片。</strong> 报告包含大量页面图片，文件可能超过 300MB，打开、搜索和打印可能较慢。</>}
              <div className="al-inline-actions"><Button appearance="primary" size="small" disabled={busy} onClick={() => void startExport(selectedFormat)}>{selectedFormat === "html" ? "仍然导出 HTML" : "仍然导出阶段性结果"}</Button><Button size="small" onClick={() => setAwaitingConfirmation(false)}>返回检查</Button></div>
            </InlineFeedback>}

            {activeJob && (
              <Card className="al-card al-export-active-card">
                <div className="al-card-heading-row"><Text weight="semibold">{exportKindLabel(activeJob.format)} 导出</Text><span className={`al-badge al-badge-${jobTone(activeJob.status)}`}>{stageLabel(activeJob)}</span></div>
                <div className="al-export-progress"><div className="al-progress-track indeterminate" role="progressbar" aria-label="导出进度" /><Text className="al-muted">{activeJob.progress_completed}/{activeJob.progress_total} · 创建于 {formatDateTime(activeJob.created_at)}</Text></div>
                <div className="al-inline-actions">
                  <Button size="small" disabled={busy || activeJob.status === "cancelling"} onClick={() => void cancelJob(activeJob.export_id)}>{activeJob.status === "cancelling" ? "正在取消…" : "取消导出"}</Button>
                </div>
              </Card>
            )}

            {jobs.length > 0 && (
              <Card className="al-card">
                <div className="al-card-heading-row"><Text weight="semibold">导出作业</Text></div>
                <div className="al-export-jobs">
                  {jobs.map((job) => (
                    <div key={job.export_id} className="al-export-job-row">
                      <div className="al-export-job-head"><strong>{exportKindLabel(job.format)}</strong><span className={`al-badge al-badge-${jobTone(job.status)}`}>{stageLabel(job)}</span></div>
                      <small className="al-muted">创建 {formatDateTime(job.created_at)}{job.finished_at ? ` · 完成 ${formatDateTime(job.finished_at)}` : ""}</small>
                      {job.status === "completed" && job.output_path && <small className="al-muted" title={job.output_path}>{job.output_path}</small>}
                      {job.error_message && <InlineFeedback tone="error">{job.error_message}</InlineFeedback>}
                      <div className="al-inline-actions">
                        {job.status === "completed" && job.output_path && <Button size="small" onClick={() => void openFolderFor(job.output_path)}>打开文件夹</Button>}
                        {(job.status === "failed" || job.status === "cancelled" || job.status === "interrupted") && <Button size="small" appearance="primary" disabled={busy || cleanupActive} onClick={() => void retryJob(job.export_id)}>重新导出</Button>}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>

          <aside className="al-export-aside" aria-label="导出完整性摘要">
            <Card className="al-card"><Text weight="semibold">导出完整性</Text><div className="al-export-integrity"><span>扫描：{summary.scan_complete ? "已完整处理" : "未完整处理"}</span><span>校对：{summary.review_complete ? "已完成" : `未完成（剩余 ${summary.review_summary.unreviewed_count} 条）`}</span></div></Card>
            {(!summary.scan_complete || !summary.review_complete) && <InlineFeedback tone="warning">阶段性报告不应作为最终核验报告；请在扫描无失败且全部结果校对后重新导出。</InlineFeedback>}
            <Card className="al-card"><div className="al-card-heading-row"><Text weight="semibold">成功导出历史</Text><Button appearance="subtle" size="small" onClick={() => void openTaskFolder()}>任务目录</Button></div>{history.length === 0 ? <Text className="al-muted">此任务尚无成功导出记录。</Text> : <div className="al-export-history">{history.map((item) => <button key={item.export_id} type="button" onClick={() => void openFolderFor(item.path)}><strong>{exportKindLabel(item.kind)}</strong><span>{formatDateTime(item.created_at)}</span><small title={item.path}>{item.path}</small></button>)}</div>}</Card>
            <Card className="al-card"><Text weight="semibold">本地处理</Text><Text className="al-muted">导出文件与历史记录均保存在当前任务工作区，不会上传到网络服务。失败或取消不会覆盖已有成功文件。</Text></Card>
          </aside>
        </div>
      )}
    </div>
  );
}
