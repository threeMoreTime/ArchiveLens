import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  Card,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Input,
  Menu,
  MenuDivider,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Text,
} from "@fluentui/react-components";
import { DocumentAddRegular, SearchRegular } from "@fluentui/react-icons";
import { useNavigate } from "react-router-dom";
import type { TaskSummary } from "../../../preload/api";
import { EmptyState, InlineFeedback, LoadingState, PageHeader } from "../components/feedback";
import { cleanupStatusView, formatDateTime, taskDisplayName, taskSourceLabel, taskStatusView } from "../utils/presentation";

const PAGE_SIZE = 20;
const DELETABLE_STATUSES = new Set(["completed", "failed", "cancelled"]);
const PAUSABLE_STATUSES = new Set(["running"]);
const TASK_ACTION_GROUPS = ["view", "control", "danger"] as const;

type TaskActionGroup = typeof TASK_ACTION_GROUPS[number];
type TaskControlAction = "start" | "pause" | "resume" | "cancel";
type TaskAction = {
  id: string;
  label: string;
  group: TaskActionGroup;
  visible: boolean;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
};

function primaryActionId(status: string): string {
  if (status === "draft") return "start";
  if (status === "running") return "pause";
  if (["paused", "recoverable"].includes(status)) return "resume";
  if (status === "completed") return "review";
  return "details";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "无法读取任务，请重试";
}

export default function TaskCenter() {
  const nav = useNavigate();
  const [items, setItems] = useState<TaskSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [status, setStatus] = useState("");
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<TaskSummary | null>(null);
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null);
  const [taskAction, setTaskAction] = useState<{ taskId: string; kind: TaskControlAction } | null>(null);
  const loadSequenceRef = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++loadSequenceRef.current;
    setLoading(true);
    setError("");
    try {
      const response = await window.archiveLens.tasks.list({
        limit: PAGE_SIZE,
        offset: pageIndex * PAGE_SIZE,
        status: status || undefined,
        query: query || undefined,
      });
      if (sequence !== loadSequenceRef.current) return;
      setItems(response.items);
      setTotal(response.total);
      const lastPage = Math.max(0, Math.ceil(response.total / PAGE_SIZE) - 1);
      if (pageIndex > lastPage) setPageIndex(lastPage);
    } catch (nextError) {
      if (sequence === loadSequenceRef.current) setError(errorMessage(nextError));
    } finally {
      if (sequence === loadSequenceRef.current) setLoading(false);
    }
  }, [pageIndex, query, status]);

  useEffect(() => {
    let refreshTimer: number | null = null;
    void load();
    const off = window.archiveLens.subscribe.onEvent(() => {
      if (refreshTimer !== null) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void load();
      }, 500);
    });
    return () => { loadSequenceRef.current += 1; if (refreshTimer !== null) window.clearTimeout(refreshTimer); off(); };
  }, [load]);

  const applyQuery = () => {
    setPageIndex(0);
    setQuery(queryInput.trim());
  };
  const deleteTask = async () => {
    if (!deleteTarget) return;
    const taskId = deleteTarget.task_id;
    setDeletingTaskId(taskId);
    setDeleteTarget(null);
    setActionError("");
    try {
      await window.archiveLens.tasks.delete(taskId);
    } catch (nextError) {
      setActionError(`删除任务失败：${errorMessage(nextError)}`);
    } finally {
      await load();
      setDeletingTaskId(null);
    }
  };
  const retryCleanup = async (taskId: string) => {
    setDeletingTaskId(taskId);
    setActionError("");
    try {
      await window.archiveLens.tasks.delete(taskId);
      await load();
    } catch (nextError) {
      setActionError(`重试清理失败：${errorMessage(nextError)}`);
    } finally {
      setDeletingTaskId(null);
    }
  };
  const openCleanupDir = async (taskId: string) => {
    setActionError("");
    try {
      await window.archiveLens.tasks.openCleanupDir(taskId);
    } catch (nextError) {
      setActionError(`打开残留目录失败：${errorMessage(nextError)}`);
    }
  };
  const runTaskAction = async (taskId: string, kind: TaskControlAction) => {
    setTaskAction({ taskId, kind });
    setActionError("");
    try {
      await window.archiveLens.tasks[kind](taskId);
      await load();
    } catch (nextError) {
      const label = { start: "启动", pause: "暂停", resume: "继续", cancel: "取消" }[kind];
      setActionError(`${label}任务失败：${errorMessage(nextError)}`);
    } finally {
      setTaskAction(null);
    }
  };
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageStart = total === 0 ? 0 : pageIndex * PAGE_SIZE + 1;
  const pageEnd = Math.min(total, (pageIndex + 1) * PAGE_SIZE);

  return (
    <div className="al-welcome al-task-center-page">
      <PageHeader title="任务中心" description="查找、继续和复核全部本地任务。任务按创建时间倒序排列。" />
      <Card className="al-card al-task-center-toolbar">
        <Input
          className="al-task-center-search"
          value={queryInput}
          aria-label="搜索任务"
          placeholder="搜索任务名称、来源目录或检索词"
          onChange={(_, data) => setQueryInput(data.value)}
          onKeyDown={(event) => { if (event.key === "Enter") applyQuery(); }}
        />
        <Button onClick={applyQuery}>搜索 <SearchRegular aria-hidden="true" /></Button>
        <select
          aria-label="任务状态筛选"
          value={status}
          onChange={(event) => { setStatus(event.target.value); setPageIndex(0); }}
        >
          <option value="">全部状态</option>
          <option value="draft">待启动</option>
          <option value="queued">排队中</option>
          <option value="starting">正在启动</option>
          <option value="running">扫描中</option>
          <option value="pausing">正在暂停</option>
          <option value="paused">已暂停</option>
          <option value="resuming">正在恢复</option>
          <option value="recoverable">可恢复</option>
          <option value="stopping">正在取消</option>
          <option value="stale">状态异常</option>
          <option value="completed">已完成或部分完成</option>
          <option value="failed">失败</option>
          <option value="cancelled">已取消</option>
        </select>
        <Button appearance="primary" onClick={() => nav("/scan/new")}>新建扫描 <DocumentAddRegular aria-hidden="true" /></Button>
      </Card>

      {error && <InlineFeedback>任务列表加载失败：{error} <Button size="small" onClick={() => void load()}>重试</Button></InlineFeedback>}
      {actionError && <InlineFeedback tone="error">{actionError}</InlineFeedback>}
      {loading && items.length === 0 && <LoadingState label="正在读取全部本地任务…" />}
      {!loading && !error && items.length === 0 && (
        <EmptyState
          title={query || status ? "没有符合条件的任务" : "尚无本地任务"}
          detail={query || status ? "尝试清除筛选或更换关键词。" : "创建扫描后，可从这里继续、校对或导出。"}
          action={query || status ? { label: "清除筛选", onClick: () => { setQueryInput(""); setQuery(""); setStatus(""); } } : { label: "新建扫描", onClick: () => nav("/scan/new") }}
        />
      )}

      {items.length > 0 && (
        <Card className="al-card al-task-table-card">
          <div className="al-task-table al-task-center-table" role="table" aria-label="全部任务">
            <div className="al-task-table-head" role="row"><span>任务</span><span>状态</span><span>进度与结果</span><span>更新时间</span><span>操作</span></div>
            {items.map((task) => {
              const statusView = taskStatusView(task);
              const cleanupView = cleanupStatusView(task.cleanup_status);
              const updatedAt = task.finished_at || task.started_at || task.created_at;
              const taskCanBeDeleted = DELETABLE_STATUSES.has(task.status);
              const taskCanBePaused = PAUSABLE_STATUSES.has(task.status);
              const taskCanBeCancelled = !taskCanBeDeleted && task.status !== "stopping";
              const actionInProgress = taskAction !== null;
              const actionIsForTask = taskAction?.taskId === task.task_id;
              // 删除生命周期中只保留“详情”；校对/导出/控制/普通删除入口隐藏，避免注定失败或重复操作
              const cleanupActive = Boolean(task.cleanup_status);
              const actions: TaskAction[] = [
                { id: "details", label: "详情", group: "view", visible: true, onSelect: () => nav(`/tasks/${task.task_id}`) },
                { id: "review", label: "校对", group: "view", visible: !cleanupActive, onSelect: () => nav(`/review/${task.task_id}`) },
                { id: "export", label: "导出", group: "view", visible: !cleanupActive, onSelect: () => nav(`/export/${task.task_id}`) },
                { id: "start", label: actionIsForTask && taskAction?.kind === "start" ? "正在启动…" : "启动任务", group: "control", visible: !cleanupActive && task.status === "draft", disabled: actionInProgress || deletingTaskId !== null, onSelect: () => void runTaskAction(task.task_id, "start") },
                { id: "pause", label: actionIsForTask && taskAction?.kind === "pause" ? "正在暂停…" : "暂停任务", group: "control", visible: !cleanupActive && taskCanBePaused, disabled: actionInProgress || deletingTaskId !== null, onSelect: () => void runTaskAction(task.task_id, "pause") },
                { id: "resume", label: actionIsForTask && taskAction?.kind === "resume" ? "正在继续…" : "继续任务", group: "control", visible: !cleanupActive && ["paused", "recoverable"].includes(task.status), disabled: actionInProgress || deletingTaskId !== null, onSelect: () => void runTaskAction(task.task_id, "resume") },
                { id: "cancel", label: actionIsForTask && taskAction?.kind === "cancel" ? "正在取消…" : "取消任务", group: "control", visible: !cleanupActive && taskCanBeCancelled, disabled: actionInProgress || deletingTaskId !== null, onSelect: () => void runTaskAction(task.task_id, "cancel") },
                { id: "delete", label: "删除任务", group: "danger", visible: !cleanupActive && taskCanBeDeleted, disabled: deletingTaskId !== null || actionInProgress, danger: true, onSelect: () => setDeleteTarget(task) },
              ];
              const visibleActions = actions.filter((action) => action.visible);
              const primaryAction = visibleActions.find((action) => action.id === primaryActionId(task.status)) ?? visibleActions[0];
              const menuActions = visibleActions.filter((action) => action.id !== primaryAction?.id);
              const taskIsRunning = ["queued", "starting", "running", "pausing", "resuming"].includes(task.status);
              const progress = task.total_pages > 0
                ? `${task.processed_pages}/${task.total_pages} 页`
                : `${task.processed_pages} 页（${taskIsRunning ? "总数统计中" : "总数未记录"}）`;
              return (
                <div className="al-task-table-row" role="row" key={task.task_id}>
                  <span className="al-task-name-cell"><strong title={taskDisplayName(task)}>{taskDisplayName(task)}</strong><small title={task.source_dir}>{taskSourceLabel(task)}</small><small>检索词：{task.search_text}</small></span>
                  <span>
                    <span className={`al-badge al-badge-${statusView.tone}`}>{statusView.label}</span>
                    {cleanupView && <span className={`al-badge al-badge-${cleanupView.tone}`}>{cleanupView.label}</span>}
                    {task.cleanup_status === "cleanup_failed" && task.cleanup_error_summary && (
                      <small className="al-task-cleanup-error" title={task.cleanup_error_summary}>{task.cleanup_error_summary}</small>
                    )}
                  </span>
                  <span className="al-task-result-cell"><strong>{task.occurrence_count} 条命中</strong><small>{progress}</small></span>
                  <span title={updatedAt || undefined}>{formatDateTime(updatedAt)}</span>
                  <span className="al-task-row-actions">{primaryAction && <Button size="small" appearance="primary" disabled={primaryAction.disabled} onClick={primaryAction.onSelect}>{primaryAction.label}</Button>}<Menu><MenuTrigger disableButtonEnhancement><Button size="small" aria-label={`${taskDisplayName(task)}更多操作`}>更多</Button></MenuTrigger><MenuPopover><MenuList>{TASK_ACTION_GROUPS.map((group, groupIndex) => { const groupActions = menuActions.filter((action) => action.group === group); if (groupActions.length === 0) return null; return <div key={group}>{groupIndex > 0 && menuActions.some((action) => TASK_ACTION_GROUPS.indexOf(action.group) < groupIndex) && <MenuDivider />}{groupActions.map((action) => <MenuItem key={action.id} disabled={action.disabled} className={action.danger ? "al-task-delete-menu-item" : undefined} onClick={action.onSelect}>{action.label}</MenuItem>)}</div>; })}</MenuList></MenuPopover></Menu>{task.cleanup_status === "cleanup_failed" && (<><Button size="small" disabled={deletingTaskId !== null} onClick={() => void retryCleanup(task.task_id)}>{deletingTaskId === task.task_id ? "正在重试…" : "重试清理"}</Button><Button size="small" onClick={() => void openCleanupDir(task.task_id)}>打开残留目录</Button></>)}</span>
                </div>
              );
            })}
          </div>
          <div className="al-task-center-pagination">
            <Text className="al-muted">第 {pageStart}–{pageEnd} 项，共 {total} 项</Text>
            <Button disabled={loading || pageIndex === 0} onClick={() => setPageIndex((value) => Math.max(0, value - 1))}>上一页</Button>
            <Text>第 {pageIndex + 1} / {totalPages} 页</Text>
            <Button disabled={loading || pageIndex >= totalPages - 1} onClick={() => setPageIndex((value) => Math.min(totalPages - 1, value + 1))}>下一页</Button>
          </div>
        </Card>
      )}
      <Dialog open={deleteTarget !== null} onOpenChange={(_event, data) => { if (!data.open && !deletingTaskId) setDeleteTarget(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>确认删除任务？</DialogTitle>
            <DialogContent>
              <div className="al-task-delete-confirmation">
                <Text>将删除“{deleteTarget ? taskDisplayName(deleteTarget) : ""}”的本地任务记录、扫描结果、校对和导出记录，以及生成的页面图片。</Text>
                <Text weight="semibold">不会删除原始文件。</Text>
                <Text className="al-muted">删除后无法恢复。</Text>
              </div>
            </DialogContent>
            <DialogActions>
              <Button disabled={deletingTaskId !== null} onClick={() => setDeleteTarget(null)}>取消</Button>
              <Button appearance="primary" className="al-task-delete-button" disabled={deletingTaskId !== null} onClick={() => void deleteTask()}>{deletingTaskId ? "正在删除…" : "删除任务"}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
