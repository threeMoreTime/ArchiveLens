import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button, Card, Text } from "@fluentui/react-components";
import type { TaskSummary } from "../../../preload/api";
import { InlineFeedback, LoadingState, PageHeader } from "../components/feedback";

type TaskData = TaskSummary & { error_code?: string; current_file?: string | null };

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    running: "扫描进行中",
    paused: "任务已暂停",
    pausing: "正在暂停",
    resuming: "正在恢复",
    recoverable: "任务可恢复",
    completed: "扫描已完成",
    failed: "扫描失败",
    cancelled: "任务已取消",
  };
  return (labels[status] ?? status) || "状态未知";
}

function badgeTone(status: string) {
  return status === "completed" ? "PASS" : ["failed", "cancelled"].includes(status) ? "FAIL" : "WARN";
}

export default function TaskPage() {
  const { taskId = "" } = useParams();
  const nav = useNavigate();
  const [task, setTask] = useState<TaskData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<"pause" | "resume" | "cancel" | null>(null);
  const legacyRequiresReview = task?.error_code === "LEGACY_TASK_REQUIRES_REVIEW";

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const nextTask = await window.archiveLens.tasks.get(taskId) as TaskData;
        if (active) setTask(nextTask);
      } catch (nextError: unknown) {
        if (active) setError(nextError instanceof Error ? nextError.message : String(nextError));
      }
    };
    void load();
    const off = window.archiveLens.subscribe.onEvent((event: { task_id?: string }) => {
      if (event?.task_id === taskId) void load();
    });
    const timer = setInterval(() => void load(), 2500);
    return () => { active = false; off(); clearInterval(timer); };
  }, [taskId]);

  const runAction = async (kind: "pause" | "resume" | "cancel") => {
    setAction(kind);
    setError(null);
    try {
      await window.archiveLens.tasks[kind](taskId);
      setTask(await window.archiveLens.tasks.get(taskId) as TaskData);
    } catch (nextError: unknown) {
      const label = kind === "pause" ? "暂停" : kind === "resume" ? "恢复" : "取消";
      setError(`${label}任务失败：${nextError instanceof Error ? nextError.message : String(nextError)}`);
    } finally {
      setAction(null);
    }
  };

  const percent = task?.total_pages ? Math.round(task.processed_pages / task.total_pages * 100) : 0;
  const statusDetail = task?.status === "completed"
    ? "扫描已完成。可进入校对工作台确认每条命中，或导出完整结果。"
    : task?.status === "paused" || task?.status === "recoverable"
      ? "任务处于可恢复状态，已完成的数据已安全保留在本机。"
      : task?.status === "failed"
        ? "任务未能继续执行。已完成的数据仍会保留，可查看错误说明后重试或重新创建任务。"
        : "正在从本地档案中提取 OCR 结果，进度会自动刷新。";

  return (
    <div className="al-welcome al-task-page">
      <PageHeader title="扫描任务" description="任务详情 · 查看扫描进度、任务状态和下一步操作。任务数据始终保留在本地工作区。" />
      {error && <InlineFeedback>{error}</InlineFeedback>}
      {!task && !error && <LoadingState label="正在读取任务状态…" />}
      {task && <div className="al-task-layout">
        <section className="al-task-main">
          <Card className="al-task-card">
            <div className="al-task-heading"><div><Text weight="semibold" size={500}>{task.name || "扫描任务"}</Text><Text className="al-muted" title={task.source_dir}>{task.source_dir}</Text></div><span className={`al-badge al-badge-${badgeTone(task.status)}`}>{statusLabel(task.status)}</span></div>
            <div className="al-task-keyfacts"><span>检索词：<strong>{task.search_text || "未提供"}</strong></span><span>匹配模式：<strong>{task.search_mode === "legacy_fixed_pair" ? "历史双字符匹配" : "精确匹配"}</strong></span><span>文件数量<strong>{task.file_count}</strong></span><span>累计命中<strong>{task.occurrence_count}</strong></span></div>
            <div className="al-progress-panel"><div><Text weight="semibold">总体进度</Text><b>{percent}%</b></div><div className="al-progress-track" aria-label={`任务进度 ${percent}%`}><span style={{ width: `${percent}%` }} /></div><Text>已处理 {task.processed_pages}/{task.total_pages} 页 · 当前状态：{statusLabel(task.status)}</Text></div>
          </Card>
          <Card className="al-card al-task-status-card"><Text weight="semibold">状态说明</Text><Text className="al-muted">{statusDetail}</Text>{task.current_file && <Text className="al-task-current-file" title={task.current_file}>当前文件：{task.current_file}</Text>}{task.error_message && <InlineFeedback>{task.error_message}</InlineFeedback>}{legacyRequiresReview && <InlineFeedback tone="warning">该 Alpha10 未完成任务缺少可信页进度，已保留旧结果但不能自动恢复。请创建新任务重新扫描。</InlineFeedback>}</Card>
          <Card className="al-card"><Text weight="semibold">扫描进度</Text><div className="al-task-stat-grid"><span><strong>{task.processed_pages}</strong> 已处理页</span><span><strong>{Math.max(0, task.total_pages - task.processed_pages)}</strong> 待处理页</span><span><strong>{task.failure_count}</strong> 失败文件</span><span><strong>{task.occurrence_count}</strong> OCR 命中</span></div></Card>
        </section>
        <aside className="al-task-aside">
          <Card className="al-card"><Text weight="semibold">下一步</Text><div className="al-task-actions"><Button appearance="primary" onClick={() => nav(`/review/${taskId}`)}>进入校对工作台</Button><Button onClick={() => nav(`/export/${taskId}`)}>导出结果</Button>{task.status === "running" && <Button disabled={Boolean(action)} onClick={() => void runAction("pause")}>{action === "pause" ? "正在请求暂停…" : "暂停任务"}</Button>}{!legacyRequiresReview && ["paused", "recoverable"].includes(task.status) && <Button disabled={Boolean(action)} onClick={() => void runAction("resume")}>{action === "resume" ? "正在恢复…" : "继续任务"}</Button>}{legacyRequiresReview && <Button onClick={() => nav("/scan/new", { state: { sourceDir: task.source_dir } })}>使用原目录新建任务</Button>}{!["cancelled", "completed"].includes(task.status) && <Button disabled={Boolean(action)} onClick={() => void runAction("cancel")}>{action === "cancel" ? "正在取消…" : "取消任务"}</Button>}</div></Card>
          <Card className="al-card"><Text weight="semibold">任务时间</Text><div className="al-task-time-list"><span>创建于<strong>{task.created_at || "—"}</strong></span><span>开始于<strong>{task.started_at || "尚未开始"}</strong></span><span>结束于<strong>{task.finished_at || "尚未结束"}</strong></span></div></Card>
          <Card className="al-card al-local-card"><Text weight="semibold">恢复与数据安全</Text><Text className="al-muted">暂停、退出或恢复不会清空已写入的扫描结果。取消会停止后续扫描，但不会删除已完成数据。</Text></Card>
        </aside>
      </div>}
    </div>
  );
}
