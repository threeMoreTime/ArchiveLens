import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Card, Text } from "@fluentui/react-components";
import type { EngineExitInfo, EnvironmentInfo, TaskSummary } from "../../../preload/api";
import { EmptyState, InlineFeedback, LoadingState, PageHeader } from "../components/feedback";
import { diagnosticStatusLabel, formatDateTime, taskDisplayName, taskSourceLabel, taskStatusView } from "../utils/presentation";

type DiagnosticCheck = NonNullable<EnvironmentInfo["engine"]>["checks"][number];

export default function Welcome() {
  const nav = useNavigate();
  const [checks, setChecks] = useState<DiagnosticCheck[]>([]);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [taskTotal, setTaskTotal] = useState(0);
  const [completedTaskTotal, setCompletedTaskTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let refreshTimer: number | null = null;
    const loadTasks = () => Promise.all([
      window.archiveLens.tasks.list({ limit: 8, offset: 0 }),
      window.archiveLens.tasks.list({ limit: 1, offset: 0, status: "completed" }),
    ]).then(([response, completed]) => {
      if (!active) return;
      setTasks(response.items);
      setTaskTotal(response.total);
      setCompletedTaskTotal(completed.total);
    }).catch((nextError: unknown) => {
      if (active) setError(nextError instanceof Error ? nextError.message : String(nextError));
    }).finally(() => {
      if (active) setLoadingTasks(false);
    });

    window.archiveLens.app.getEnvironment().then((env: EnvironmentInfo) => {
      if (!active) return;
      setChecks(env.engine?.checks ?? []);
      if (env.startupError) setError(`${env.startupError.message}。可前往“环境诊断”查看处理建议和日志。`);
    }).catch((nextError: unknown) => active && setError(nextError instanceof Error ? nextError.message : String(nextError)));
    const scheduleTasks = () => {
      if (refreshTimer !== null) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void loadTasks();
      }, 500);
    };
    void loadTasks();
    const offEvent = window.archiveLens.subscribe.onEvent(scheduleTasks);
    const offExit = window.archiveLens.subscribe.onEngineExit((info: EngineExitInfo) => {
      if (!info.expected) setError(`本地识别服务异常退出（${info.kind}）。任务数据仍保留在本机；请打开环境诊断并查看日志。`);
    });
    return () => { active = false; if (refreshTimer !== null) window.clearTimeout(refreshTimer); offEvent(); offExit(); };
  }, []);

  const currentTask = useMemo(
    () => tasks.find((task) => ["running", "paused", "recoverable"].includes(task.status)) ?? tasks[0] ?? null,
    [tasks],
  );
  const recentOccurrenceCount = tasks.reduce((sum, task) => sum + (task.occurrence_count ?? 0), 0);
  const constrainedChecks = checks.filter((check) => check.status !== "PASS");
  const currentTaskHasKnownTotal = Boolean(currentTask && currentTask.total_pages > 0);
  const currentTaskIsActive = Boolean(currentTask && ["queued", "starting", "running", "pausing", "resuming"].includes(currentTask.status));

  const tryDemo = async () => {
    setBusy(true);
    setError(null);
    try {
      const demo = await window.archiveLens.demo.create();
      nav(`/review/${demo.task_id}`);
    } catch (nextError: unknown) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="al-welcome al-home-page">
      <PageHeader
        title={taskTotal > 0 ? "欢迎回来，继续处理档案" : "欢迎使用 ArchiveLens"}
        description="在本机扫描 PDF、DJVU、DJV、TIFF、JPEG 和 PNG 文件，定位你指定的文字或词语；档案内容不会上传到网络。"
      />
      {error && <InlineFeedback>无法完成部分本地检查：{error} <Button size="small" onClick={() => nav("/diagnostics")}>查看诊断</Button></InlineFeedback>}

      <div className="al-home-hero">
        <section className="al-home-intro">
          <Text weight="semibold" size={500}>{taskTotal > 0 ? "继续现有任务，或开始新的扫描" : "从一个清晰的工作流开始"}</Text>
          <Text className="al-muted">选择档案文件夹、输入检索词、查看命中并完成校对。任务进度和结果会保留在本机。</Text>
          <div className="al-welcome-actions"><Button appearance="primary" size="large" onClick={() => nav("/scan/new")}>新建扫描</Button><Button size="large" onClick={tryDemo} disabled={busy}>{busy ? "正在准备示例…" : "体验示例"}</Button></div>
        </section>
        <Card className="al-home-current-card">
          <div className="al-task-heading"><Text weight="semibold">当前任务</Text>{currentTask && (() => { const view = taskStatusView(currentTask); return <span className={`al-badge al-badge-${view.tone}`}>{view.label}</span>; })()}</div>
          {!currentTask ? <Text className="al-muted">还没有本地任务。从“新建扫描”开始即可创建第一项工作。</Text> : <>
            <Text weight="semibold" title={taskDisplayName(currentTask)}>{taskDisplayName(currentTask)}</Text>
            <Text className="al-muted">检索词：{currentTask.search_text}</Text>
            <div className={`al-progress-track ${!currentTaskHasKnownTotal && currentTaskIsActive ? "indeterminate" : ""}`}><span style={currentTaskHasKnownTotal ? { width: `${Math.min(100, Math.round(currentTask.processed_pages / currentTask.total_pages * 100))}%` } : undefined} /></div>
            <Text className="al-muted">{currentTaskHasKnownTotal ? `已处理 ${currentTask.processed_pages}/${currentTask.total_pages} 页` : currentTaskIsActive ? `已处理 ${currentTask.processed_pages} 页，正在统计总页数` : `已处理 ${currentTask.processed_pages} 页，总页数未记录`} · {currentTask.occurrence_count} 条命中</Text>
            <Button size="small" onClick={() => nav(`/tasks/${currentTask.task_id}`)}>进入任务</Button>
          </>}
        </Card>
      </div>

      <div className="al-home-layout">
        <section className="al-home-main">
          <div className="al-section-heading-row"><Text className="al-section-heading" weight="semibold">最近任务</Text>{taskTotal > 0 && <Button appearance="subtle" size="small" onClick={() => nav("/tasks")}>查看全部 {taskTotal} 项</Button>}</div>
          <Card className="al-card al-task-table-card">
            {loadingTasks && <LoadingState label="正在读取本地任务…" />}
            {!loadingTasks && tasks.length === 0 && <EmptyState title="尚无任务" detail="选择一个文件夹并输入检索词后，最近任务会显示在这里。" action={{ label: "新建扫描", onClick: () => nav("/scan/new") }} />}
            {!loadingTasks && tasks.length > 0 && <div className="al-task-table" role="table" aria-label="最近任务"><div className="al-task-table-head" role="row"><span>任务</span><span>状态</span><span>结果</span><span>更新时间</span><span>操作</span></div>{tasks.map((task) => { const view = taskStatusView(task); const updatedAt = task.finished_at || task.started_at || task.created_at; return <div className="al-task-table-row" role="row" key={task.task_id}><span className="al-task-name-cell"><strong title={taskDisplayName(task)}>{taskDisplayName(task)}</strong><small title={task.source_dir}>{taskSourceLabel(task)}</small></span><span><span className={`al-badge al-badge-${view.tone}`}>{view.label}</span></span><span>{task.occurrence_count} 条</span><span title={updatedAt || undefined}>{formatDateTime(updatedAt)}</span><Button size="small" onClick={() => nav(`/tasks/${task.task_id}`)}>{["completed", "failed", "cancelled"].includes(task.status) ? "查看" : "继续"}</Button></div>; })}</div>}
          </Card>
          <Text className="al-section-heading" weight="semibold">使用流程</Text>
          <div className="al-workflow-grid"><Card className="al-card"><strong>1. 创建扫描</strong><Text className="al-muted">选择本地档案文件夹并设置精确检索词。</Text></Card><Card className="al-card"><strong>2. 处理与恢复</strong><Text className="al-muted">查看进度、暂停任务，并在异常退出后安全恢复。</Text></Card><Card className="al-card"><strong>3. 校对与导出</strong><Text className="al-muted">逐条确认命中，再导出带完整性状态的结果。</Text></Card></div>
        </section>
        <aside className="al-home-aside">
          <Card className="al-card"><div className="al-card-heading-row"><Text weight="semibold">环境摘要</Text><Button appearance="subtle" size="small" onClick={() => nav("/diagnostics")}>查看详情</Button></div><div className="al-env-list">{checks.length === 0 && !error && <LoadingState label="正在检查本地环境…" />}{checks.map((check) => <div className="al-env-row" key={check.key}><span title={check.detail}>{check.label}</span><span className={`al-badge al-badge-${check.status}`}>{diagnosticStatusLabel(check.status)}</span></div>)}</div>{constrainedChecks[0]?.impact && <InlineFeedback tone="warning">{constrainedChecks[0].impact}</InlineFeedback>}</Card>
          <Card className="al-card"><Text weight="semibold">工作概览</Text><div className="al-metric-grid"><span><strong>{taskTotal}</strong> 本地任务</span><span><strong>{completedTaskTotal}</strong> 已完成</span><span><strong>{recentOccurrenceCount}</strong> 最近任务命中</span></div></Card>
          <Card className="al-card al-local-card"><Text weight="semibold">本地处理与隐私</Text><Text className="al-muted">OCR、校对、导出和任务恢复均在当前计算机完成。</Text></Card>
        </aside>
      </div>
    </div>
  );
}
