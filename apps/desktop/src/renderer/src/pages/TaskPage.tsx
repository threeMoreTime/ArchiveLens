import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { Button, Card, Text } from "@fluentui/react-components";
import type { TaskFailure, TaskSummary } from "../../../preload/api";
import { InlineFeedback, LoadingState, PageHeader } from "../components/feedback";
import { formatDateTime, taskDisplayName, taskSourceLabel, taskStatusView } from "../utils/presentation";

type TaskData = TaskSummary & { error_code?: string; current_file?: string | null; failures?: TaskFailure[] };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function TaskPage() {
  const { taskId = "" } = useParams();
  const nav = useNavigate();
  const location = useLocation();
  const [task, setTask] = useState<TaskData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [action, setAction] = useState<"start" | "pause" | "resume" | "cancel" | "open-folder" | "open-logs" | null>(null);
  const loadSequenceRef = useRef(0);
  const legacyRequiresReview = task?.error_code === "LEGACY_TASK_REQUIRES_REVIEW";
  const startError = (location.state as { startError?: unknown } | null)?.startError;

  const load = useCallback(async () => {
    const sequence = ++loadSequenceRef.current;
    try {
      const nextTask = await window.archiveLens.tasks.get(taskId) as TaskData;
      if (sequence !== loadSequenceRef.current) return;
      setTask(nextTask);
      setLoadError(null);
    } catch (nextError: unknown) {
      if (sequence !== loadSequenceRef.current) return;
      setLoadError(errorMessage(nextError));
    }
  }, [taskId]);

  useEffect(() => {
    setTask(null);
    setLoadError(null);
    void load();
    const off = window.archiveLens.subscribe.onEvent((event: { task_id?: string }) => {
      if (event?.task_id === taskId) void load();
    });
    const timer = setInterval(() => void load(), 2500);
    return () => { loadSequenceRef.current += 1; off(); clearInterval(timer); };
  }, [load, taskId]);

  useEffect(() => {
    setActionError(typeof startError === "string" && startError
      ? `任务已创建，但启动请求失败：${startError}。请检查环境后点击“启动任务”重试。`
      : null);
  }, [startError, taskId]);

  const runAction = async (kind: "start" | "pause" | "resume" | "cancel") => {
    setAction(kind);
    setActionError(null);
    try {
      await window.archiveLens.tasks[kind](taskId);
      await load();
    } catch (nextError: unknown) {
      const label = kind === "start" ? "启动" : kind === "pause" ? "暂停" : kind === "resume" ? "恢复" : "取消";
      setActionError(`${label}任务失败：${errorMessage(nextError)}。任务数据仍保留在本机，可重试或查看日志。`);
    } finally {
      setAction(null);
    }
  };

  const openTaskFolder = async () => {
    if (!task?.workspace_dir) return;
    setAction("open-folder");
    setActionError(null);
    try {
      await window.archiveLens.files.openFolder(task.workspace_dir);
    } catch (nextError) {
      setActionError(`无法打开任务目录：${errorMessage(nextError)}`);
    } finally {
      setAction(null);
    }
  };

  const openLogs = async () => {
    setAction("open-logs");
    setActionError(null);
    try {
      await window.archiveLens.app.openLogDirectory();
    } catch (nextError) {
      setActionError(`无法打开日志目录：${errorMessage(nextError)}`);
    } finally {
      setAction(null);
    }
  };

  const knownTotal = Boolean(task && task.total_pages > 0);
  const percent = task && knownTotal ? Math.min(100, Math.round(task.processed_pages / task.total_pages * 100)) : 0;
  const activeStatus = Boolean(task && ["queued", "starting", "running", "pausing", "resuming"].includes(task.status));
  const statusView = task ? taskStatusView(task) : null;
  const failureDetails = task?.failures ?? [];
  const statusDetail = !task ? "" : task.status === "completed" && task.failure_count > 0
    ? `任务已处理结束，但有 ${task.failure_count} 项失败，结果可能缺页。请先查看失败明细，再决定是否校对或导出阶段性结果。`
    : task.status === "draft"
      ? "任务已经创建，但尚未启动。确认本地识别环境后，点击“启动任务”继续；无需重新创建任务。"
      : task.status === "completed"
      ? "扫描已完成。可进入校对工作台确认每条命中，或导出完整结果。"
      : ["paused", "recoverable"].includes(task.status)
        ? "任务处于可恢复状态，已完成的数据已安全保留在本机。"
        : task.status === "failed"
          ? "任务未能继续执行。已完成的数据仍会保留；查看失败原因和日志后，可使用原目录重新创建任务。"
          : task.status === "cancelled"
            ? "任务已取消，取消前保存的结果仍可查看和导出。"
            : "正在从本地档案中提取 OCR 结果，进度会自动刷新。";

  return (
    <div className="al-welcome al-task-page">
      <PageHeader title="扫描任务" description="查看真实扫描进度、失败明细和下一步操作；任务数据始终保留在本地工作区。" />
      {loadError && <InlineFeedback>任务状态读取失败：{loadError} <Button size="small" onClick={() => void load()}>重试</Button></InlineFeedback>}
      {actionError && <InlineFeedback>{actionError}</InlineFeedback>}
      {!task && !loadError && <LoadingState label="正在读取任务状态…" />}
      {task && statusView && <div className="al-task-layout">
        <section className="al-task-main">
          <Card className="al-task-card">
            <div className="al-task-heading"><div><Text weight="semibold" size={500}>{taskDisplayName(task)}</Text><Text className="al-muted" title={task.source_dir}>{taskSourceLabel(task)}</Text></div><span className={`al-badge al-badge-${statusView.tone}`}>{statusView.label}</span></div>
            <div className="al-task-keyfacts"><span>检索词<strong>{task.search_text || "未提供"}</strong></span><span>匹配模式<strong>{task.search_mode === "legacy_fixed_pair" ? "历史双字符匹配" : "精确匹配"}</strong></span><span>文件数量<strong>{task.file_count}</strong></span><span>累计命中<strong>{task.occurrence_count}</strong></span></div>
            <div className="al-progress-panel">
              <div><Text weight="semibold">总体进度</Text><b>{knownTotal ? `${percent}%` : activeStatus ? "统计中" : task.total_pages === 0 ? "无页面" : "未知"}</b></div>
              <div className={`al-progress-track ${!knownTotal && activeStatus ? "indeterminate" : ""}`} role="progressbar" aria-label={knownTotal ? `任务进度 ${percent}%` : "正在统计任务总页数"} aria-valuenow={knownTotal ? percent : undefined} aria-valuemin={knownTotal ? 0 : undefined} aria-valuemax={knownTotal ? 100 : undefined}><span style={knownTotal ? { width: `${percent}%` } : undefined} /></div>
              <Text>{knownTotal ? `已处理 ${task.processed_pages}/${task.total_pages} 页` : activeStatus ? `已处理 ${task.processed_pages} 页，正在统计总页数` : `已处理 ${task.processed_pages} 页`} · 当前状态：{statusView.label}</Text>
            </div>
          </Card>
          <Card className="al-card al-task-status-card"><Text weight="semibold">状态说明</Text><Text className="al-muted">{statusDetail}</Text>{task.current_file && <Text className="al-task-current-file" title={task.current_file}>当前文件：{task.current_file}</Text>}{task.error_message && <InlineFeedback tone={task.failure_count > 0 ? "warning" : "error"}>{task.error_message}</InlineFeedback>}{legacyRequiresReview && <InlineFeedback tone="warning">该旧版本未完成任务缺少可信页进度。旧结果已保留，但不能自动恢复；请使用原目录创建新任务。</InlineFeedback>}</Card>
          <Card className="al-card"><Text weight="semibold">扫描进度</Text><div className="al-task-stat-grid"><span><strong>{task.processed_pages}</strong> 已处理页</span><span><strong>{knownTotal ? Math.max(0, task.total_pages - task.processed_pages) : "—"}</strong> {knownTotal ? "待处理页" : activeStatus ? "总页数统计中" : "总页数未记录"}</span><span><strong>{task.failure_count}</strong> 失败项</span><span><strong>{task.occurrence_count}</strong> OCR 命中</span></div></Card>

          {task.failure_count > 0 && <Card className="al-card al-task-failures"><div className="al-card-heading-row"><Text weight="semibold">失败明细</Text><Button size="small" onClick={() => void openLogs()}>查看日志</Button></div>{failureDetails.length === 0 ? <InlineFeedback tone="warning">该任务来自旧版本，只记录了失败数量，未保存结构化明细。请查看日志定位原因。</InlineFeedback> : <><Text className="al-muted">以下项目可能造成漏检；修复环境或源文件后，建议使用原目录重新扫描。</Text><div className="al-failure-list">{failureDetails.map((failure, index) => <div key={failure.failure_id || `${failure.file_path}-${failure.page_number}-${index}`}><strong title={failure.file_path}>{failure.file_path || "任务级错误"}{failure.page_number ? ` · 第 ${failure.page_number} 页` : ""}</strong><span>{failure.error_type || failure.stage || "处理失败"}：{failure.error_message || "未提供错误详情"}</span><small>{failure.possible_missed_hits ? "可能存在漏检" : "未标记为漏检风险"}</small></div>)}</div>{task.failure_count > failureDetails.length && <Text className="al-muted">当前仅显示前 {failureDetails.length} 项；完整的 {task.failure_count} 项记录请在任务日志和报告中查看。</Text>}</>}</Card>}
        </section>
        <aside className="al-task-aside">
          <Card className="al-card"><Text weight="semibold">下一步</Text><div className="al-task-actions">{task.status === "draft" ? <Button appearance="primary" disabled={Boolean(action)} onClick={() => void runAction("start")}>{action === "start" ? "正在启动…" : "启动任务"}</Button> : <Button appearance="primary" onClick={() => nav(`/review/${taskId}`)}>进入校对工作台</Button>}<Button onClick={() => nav(`/export/${taskId}`)}>导出结果</Button>{task.status === "running" && <Button disabled={Boolean(action)} onClick={() => void runAction("pause")}>{action === "pause" ? "正在请求暂停…" : "暂停任务"}</Button>}{!legacyRequiresReview && ["paused", "recoverable"].includes(task.status) && <Button disabled={Boolean(action)} onClick={() => void runAction("resume")}>{action === "resume" ? "正在恢复…" : "继续任务"}</Button>}{!legacyRequiresReview && !["cancelled", "completed", "failed"].includes(task.status) && <Button disabled={Boolean(action)} onClick={() => void runAction("cancel")}>{action === "cancel" ? "正在取消…" : "取消任务"}</Button>}{["failed", "cancelled"].includes(task.status) || legacyRequiresReview || task.failure_count > 0 ? <Button onClick={() => nav("/scan/new", { state: task.source_kind === "files" ? { sourceKind: "files", sourceFiles: task.source_files } : { sourceDir: task.source_dir } })}>{task.source_kind === "files" ? "使用原文件清单新建任务" : "使用原目录新建任务"}</Button> : null}<Button appearance="subtle" onClick={() => nav("/tasks")}>返回任务中心</Button></div></Card>
          <Card className="al-card"><Text weight="semibold">数据与诊断</Text><div className="al-task-actions"><Button disabled={!task.workspace_dir || Boolean(action)} onClick={() => void openTaskFolder()}>{action === "open-folder" ? "正在打开…" : "打开任务目录"}</Button><Button disabled={Boolean(action)} onClick={() => void openLogs()}>{action === "open-logs" ? "正在打开…" : "打开应用日志"}</Button><Button onClick={() => nav("/diagnostics")}>环境诊断</Button></div></Card>
          <Card className="al-card"><Text weight="semibold">时间记录</Text><div className="al-task-time-list"><span>创建时间<strong>{formatDateTime(task.created_at)}</strong></span><span>开始时间<strong>{formatDateTime(task.started_at)}</strong></span><span>完成时间<strong>{formatDateTime(task.finished_at)}</strong></span></div></Card>
          <Card className="al-card al-local-card"><Text weight="semibold">本地数据</Text><Text className="al-muted">任务目录包含 OCR 页面证据、校对记录和导出文件。请在备份该目录后再进行手工清理。</Text></Card>
        </aside>
      </div>}
    </div>
  );
}
