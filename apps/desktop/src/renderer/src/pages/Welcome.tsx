import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Card, Text } from "@fluentui/react-components";
import type { EngineExitInfo, EnvironmentInfo, TaskSummary } from "../../../preload/api";
import { EmptyState, InlineFeedback, LoadingState, PageHeader } from "../components/feedback";

function taskLabel(status: string) {
  const labels: Record<string, string> = {
    completed: "已完成",
    running: "扫描中",
    paused: "已暂停",
    recoverable: "可恢复",
    failed: "失败",
    cancelled: "已取消",
  };
  return (labels[status] ?? status) || "状态未知";
}

function taskBadge(status: string) {
  if (status === "completed") return "PASS";
  if (status === "failed" || status === "cancelled") return "FAIL";
  return "WARN";
}

export default function Welcome() {
  const nav = useNavigate();
  const [checks, setChecks] = useState<{ label: string; status: string }[]>([]);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const loadTasks = () => window.archiveLens.tasks.list({ limit: 8, offset: 0 }).then((response: { items: TaskSummary[] }) => {
      if (active) setTasks(response.items);
    }).catch((nextError: unknown) => {
      if (active) setError(nextError instanceof Error ? nextError.message : String(nextError));
    }).finally(() => {
      if (active) setLoadingTasks(false);
    });

    window.archiveLens.app
      .getEnvironment()
      .then((env: EnvironmentInfo) => {
        if (!active) return;
        setChecks(env.engine?.checks ?? []);
        if (env.startupError) setError(`${env.startupError.code}: ${env.startupError.message}`);
      })
      .catch((nextError: unknown) => active && setError(nextError instanceof Error ? nextError.message : String(nextError)));
    void loadTasks();
    const offEvent = window.archiveLens.subscribe.onEvent(() => { void loadTasks(); });
    const offExit = window.archiveLens.subscribe.onEngineExit((info: EngineExitInfo) => {
      if (!info.expected) setError(`本地识别服务已退出（${info.kind}）。已保存的任务数据不会丢失。`);
    });
    return () => { active = false; offEvent(); offExit(); };
  }, []);

  const currentTask = useMemo(
    () => tasks.find((task) => ["running", "paused", "recoverable"].includes(task.status)) ?? tasks[0] ?? null,
    [tasks],
  );
  const completedTasks = tasks.filter((task) => task.status === "completed").length;
  const occurrenceCount = tasks.reduce((sum, task) => sum + (task.occurrence_count ?? 0), 0);

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
      <PageHeader title="欢迎回来，开始处理档案" description="欢迎使用 ArchiveLens。在本机扫描 PDF、DJVU、DJV 文件，定位你指定的文字或词语。文档内容不会上传到网络。" />
      {error && <InlineFeedback>无法完成部分本地检查：{error}</InlineFeedback>}

      <div className="al-home-hero">
        <section className="al-home-intro">
          <Text weight="semibold" size={500}>从一个清晰的工作流开始</Text>
          <Text className="al-muted">选择档案、输入检索词、查看命中并完成校对。所有步骤会保留在当前任务中。</Text>
          <div className="al-welcome-actions"><Button appearance="primary" size="large" onClick={() => nav("/scan/new")}>新建扫描</Button><Button size="large" onClick={tryDemo} disabled={busy}>{busy ? "正在准备示例…" : "体验示例"}</Button></div>
        </section>
        <Card className="al-home-current-card">
          <div className="al-task-heading"><Text weight="semibold">当前任务</Text>{currentTask && <span className={`al-badge al-badge-${taskBadge(currentTask.status)}`}>{taskLabel(currentTask.status)}</span>}</div>
          {!currentTask ? <Text className="al-muted">还没有本地任务。从新建扫描开始即可创建第一项工作。</Text> : <><Text weight="semibold" title={currentTask.name}>{currentTask.name || "扫描任务"}</Text><Text className="al-muted">检索词：{currentTask.search_text}</Text><div className="al-progress-track"><span style={{ width: `${currentTask.total_pages ? Math.round(currentTask.processed_pages / currentTask.total_pages * 100) : 0}%` }} /></div><Text className="al-muted">已处理 {currentTask.processed_pages}/{currentTask.total_pages} 页 · {currentTask.occurrence_count} 条命中</Text><Button size="small" onClick={() => nav(`/tasks/${currentTask.task_id}`)}>进入任务</Button></>}
        </Card>
      </div>

      <div className="al-home-layout">
        <section className="al-home-main">
          <Text className="al-section-heading" weight="semibold">最近任务</Text>
          <Card className="al-card al-task-table-card">
            {loadingTasks && <LoadingState label="正在读取本地任务…" />}
            {!loadingTasks && tasks.length === 0 && <EmptyState title="尚无任务" detail="选择一个文件夹并输入检索词后，最近任务会显示在这里。" action={{ label: "新建扫描", onClick: () => nav("/scan/new") }} />}
            {!loadingTasks && tasks.length > 0 && <div className="al-task-table" role="table" aria-label="最近任务"><div className="al-task-table-head" role="row"><span>任务</span><span>状态</span><span>结果</span><span>更新时间</span><span>操作</span></div>{tasks.map((task) => <div className="al-task-table-row" role="row" key={task.task_id}><span className="al-task-name-cell"><strong title={task.name}>{task.name || "扫描任务"}</strong><small title={task.source_dir}>{task.source_dir}</small></span><span><span className={`al-badge al-badge-${taskBadge(task.status)}`}>{taskLabel(task.status)}</span></span><span>{task.occurrence_count} 条</span><span>{task.finished_at || task.started_at || task.created_at || "—"}</span><Button size="small" onClick={() => nav(`/tasks/${task.task_id}`)}>{task.status === "completed" ? "查看" : "继续"}</Button></div>)}</div>}
          </Card>
          <Text className="al-section-heading" weight="semibold">使用流程</Text>
          <div className="al-workflow-grid"><Card className="al-card"><strong>1. 创建扫描</strong><Text className="al-muted">选择本地档案并设置精确检索词。</Text></Card><Card className="al-card"><strong>2. 处理与恢复</strong><Text className="al-muted">随时查看进度、暂停或安全恢复任务。</Text></Card><Card className="al-card"><strong>3. 校对与导出</strong><Text className="al-muted">逐条确认命中，再导出完整结果。</Text></Card></div>
        </section>
        <aside className="al-home-aside">
          <Card className="al-card"><Text weight="semibold">环境摘要</Text><div className="al-env-list">{checks.length === 0 && !error && <LoadingState label="正在检查本地环境…" />}{checks.map((check) => <div className="al-env-row" key={check.label}><span>{check.label}</span><span className={`al-badge al-badge-${check.status}`}>{check.status}</span></div>)}</div></Card>
          <Card className="al-card"><Text weight="semibold">工作概览</Text><div className="al-metric-grid"><span><strong>{tasks.length}</strong> 本地任务</span><span><strong>{completedTasks}</strong> 已完成</span><span><strong>{occurrenceCount}</strong> 条命中</span></div></Card>
          <Card className="al-card al-local-card"><Text weight="semibold">本地处理与隐私</Text><Text className="al-muted">OCR、校对、导出和任务恢复均在当前计算机完成。</Text></Card>
        </aside>
      </div>
    </div>
  );
}
