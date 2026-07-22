import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  Card,
  Checkbox,
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
import { cleanupStatusView, effectiveCleanupStatus, formatDateTime, taskDisplayName, taskSourceLabel, taskStatusView } from "../utils/presentation";
import { batchActionLabel, batchEligibility, batchPreview, type BatchTaskAction } from "../utils/taskBatchActions";

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
type BatchTarget = { taskId: string; taskName: string };
type BatchResultItem = BatchTarget & { message: string };
type BatchReport = {
  action: BatchTaskAction;
  requested: number;
  success: BatchResultItem[];
  skipped: BatchResultItem[];
  failed: BatchResultItem[];
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
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(() => new Set());
  const [batchRun, setBatchRun] = useState<{ action: BatchTaskAction; currentTaskId: string | null } | null>(null);
  const [batchDeleteTargets, setBatchDeleteTargets] = useState<TaskSummary[] | null>(null);
  const [batchReport, setBatchReport] = useState<BatchReport | null>(null);
  const loadSequenceRef = useRef(0);
  const batchRunRef = useRef(false);

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

  useEffect(() => {
    setSelectedTaskIds(new Set());
  }, [pageIndex, query, status]);

  const applyQuery = () => {
    setSelectedTaskIds(new Set());
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
  const executeBatch = async (action: BatchTaskAction, targets: BatchTarget[]) => {
    if (batchRunRef.current || targets.length === 0) return;
    const boundedTargets = targets.slice(0, PAGE_SIZE);
    batchRunRef.current = true;
    const success: BatchResultItem[] = [];
    const skipped: BatchResultItem[] = [];
    const failed: BatchResultItem[] = [];
    setBatchReport(null);
    setActionError("");
    setBatchRun({ action, currentTaskId: null });
    try {
      for (const target of boundedTargets) {
        setBatchRun({ action, currentTaskId: target.taskId });
        let current: TaskSummary;
        try {
          current = await window.archiveLens.tasks.get(target.taskId);
        } catch (nextError) {
          failed.push({ ...target, message: `读取最新状态失败：${errorMessage(nextError)}` });
          continue;
        }
        const eligibility = batchEligibility(current, action);
        if (!eligibility.executable) {
          skipped.push({ ...target, message: eligibility.reason });
          continue;
        }
        try {
          if (action === "pause") await window.archiveLens.tasks.pause(target.taskId);
          if (action === "cancel") await window.archiveLens.tasks.cancel(target.taskId);
          if (action === "delete") await window.archiveLens.tasks.delete(target.taskId);
          success.push({ ...target, message: eligibility.label });
        } catch (nextError) {
          failed.push({ ...target, message: errorMessage(nextError) });
        }
      }
      setBatchReport({ action, requested: boundedTargets.length, success, skipped, failed });
      setSelectedTaskIds(new Set());
      setBatchDeleteTargets(null);
      await load();
    } finally {
      batchRunRef.current = false;
      setBatchRun(null);
    }
  };
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageStart = total === 0 ? 0 : pageIndex * PAGE_SIZE + 1;
  const pageEnd = Math.min(total, (pageIndex + 1) * PAGE_SIZE);
  const selectedTasks = items.filter((task) => selectedTaskIds.has(task.task_id)).slice(0, PAGE_SIZE);
  const allCurrentPageSelected = items.length > 0 && items.every((task) => selectedTaskIds.has(task.task_id));
  const pausePreview = batchPreview(selectedTasks, "pause");
  const cancelPreview = batchPreview(selectedTasks, "cancel");
  const deletePreview = batchPreview(selectedTasks, "delete");
  const batchDeleteConfirmationPreview = batchPreview(batchDeleteTargets ?? [], "delete");
  const batchBusy = batchRun !== null;
  const activeDeletingTaskId = deletingTaskId ?? (batchRun?.action === "delete" ? batchRun.currentTaskId : null);

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
          onChange={(event) => { setSelectedTaskIds(new Set()); setStatus(event.target.value); setPageIndex(0); }}
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

      {selectedTasks.length > 0 && (
        <Card className="al-card al-task-batch-bar" aria-label="批量任务操作">
          <div>
            <Text weight="semibold">已选择 {selectedTasks.length} 个任务</Text>
            <Text className="al-muted">单次最多 20 个；操作前会重新核验每项最新状态，并按顺序执行。</Text>
          </div>
          <div className="al-task-batch-counts" aria-label="批量操作预检">
            <span>可暂停 {pausePreview.executable}，跳过 {pausePreview.skipped}</span>
            <span>可取消 {cancelPreview.executable}，跳过 {cancelPreview.skipped}</span>
            <span>可删除或重试清理 {deletePreview.executable}，跳过 {deletePreview.skipped}</span>
          </div>
          <div className="al-task-batch-actions">
            <Button
              disabled={batchBusy || pausePreview.executable === 0}
              onClick={() => void executeBatch("pause", selectedTasks.map((task) => ({ taskId: task.task_id, taskName: taskDisplayName(task) })))}
            >批量暂停</Button>
            <Button
              disabled={batchBusy || cancelPreview.executable === 0}
              onClick={() => void executeBatch("cancel", selectedTasks.map((task) => ({ taskId: task.task_id, taskName: taskDisplayName(task) })))}
            >批量取消</Button>
            <Button
              className="al-task-delete-button"
              disabled={batchBusy || deletePreview.executable === 0}
              onClick={() => setBatchDeleteTargets(selectedTasks)}
            >批量删除</Button>
            <Button disabled={batchBusy} onClick={() => setSelectedTaskIds(new Set())}>清除选择</Button>
          </div>
          {batchRun && <InlineFeedback tone="warning">正在批量{batchActionLabel(batchRun.action)}，请勿关闭应用。</InlineFeedback>}
        </Card>
      )}

      {batchReport && (
        <Card className="al-card al-task-batch-report" aria-live="polite">
          <div className="al-card-heading-row">
            <div>
              <Text weight="semibold">批量{batchActionLabel(batchReport.action)}结果</Text>
              <Text className="al-muted">请求 {batchReport.requested} 项；成功 {batchReport.success.length}，跳过 {batchReport.skipped.length}，失败 {batchReport.failed.length}。</Text>
            </div>
            {batchReport.failed.length > 0 && (
              <Button
                disabled={batchBusy || taskAction !== null || deletingTaskId !== null}
                onClick={() => void executeBatch(batchReport.action, batchReport.failed.map(({ taskId, taskName }) => ({ taskId, taskName })))}
              >重试失败项（{batchReport.failed.length}）</Button>
            )}
          </div>
          <div className="al-task-batch-result-columns">
            <div><strong>成功</strong>{batchReport.success.length === 0 ? <small>无</small> : <ul>{batchReport.success.map((item) => <li key={item.taskId}><span>{item.taskName}</span><small>{item.message}</small></li>)}</ul>}</div>
            <div><strong>跳过</strong>{batchReport.skipped.length === 0 ? <small>无</small> : <ul>{batchReport.skipped.map((item) => <li key={item.taskId}><span>{item.taskName}</span><small>{item.message}</small></li>)}</ul>}</div>
            <div><strong>失败</strong>{batchReport.failed.length === 0 ? <small>无</small> : <ul>{batchReport.failed.map((item) => <li key={item.taskId}><span>{item.taskName}</span><small>{item.message}</small></li>)}</ul>}</div>
          </div>
        </Card>
      )}

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
            <div className="al-task-table-head" role="row">
              <span className="al-task-select-cell" role="columnheader">
                <Checkbox
                  label="选择当前页"
                  checked={allCurrentPageSelected ? true : selectedTasks.length > 0 ? "mixed" : false}
                  disabled={batchBusy}
                  onChange={(_event, data) => setSelectedTaskIds(data.checked === true
                    ? new Set(items.slice(0, PAGE_SIZE).map((task) => task.task_id))
                    : new Set())}
                />
              </span>
              <span role="columnheader">任务</span><span role="columnheader">状态</span><span role="columnheader">进度与结果</span><span role="columnheader">更新时间</span><span role="columnheader">操作</span>
            </div>
            {items.map((task) => {
              const statusView = taskStatusView(task);
              // 有效清理状态：已持久化优先；请求在途（deletingTaskId 命中）作 optimistic pending
              const effectiveCleanup = effectiveCleanupStatus(task, activeDeletingTaskId);
              const cleanupView = cleanupStatusView(effectiveCleanup);
              const updatedAt = task.finished_at || task.started_at || task.created_at;
              const taskCanBeDeleted = DELETABLE_STATUSES.has(task.status);
              const taskCanBePaused = PAUSABLE_STATUSES.has(task.status);
              const taskCanBeCancelled = !taskCanBeDeleted && task.status !== "stopping";
              const actionInProgress = taskAction !== null || batchBusy;
              const actionIsForTask = taskAction?.taskId === task.task_id;
              // 删除生命周期中（含请求在途）只保留“详情”；校对/导出/控制/普通删除入口隐藏
              const cleanupActive = Boolean(effectiveCleanup);
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
                <div className={`al-task-table-row${selectedTaskIds.has(task.task_id) ? " selected" : ""}`} role="row" key={task.task_id}>
                  <span className="al-task-select-cell" role="cell">
                    <Checkbox
                      aria-label={`选择任务 ${taskDisplayName(task)}`}
                      checked={selectedTaskIds.has(task.task_id)}
                      disabled={batchBusy}
                      onChange={(_event, data) => setSelectedTaskIds((current) => {
                        const next = new Set(current);
                        if (data.checked === true) {
                          if (next.size < PAGE_SIZE) next.add(task.task_id);
                        } else {
                          next.delete(task.task_id);
                        }
                        return next;
                      })}
                    />
                  </span>
                  <span className="al-task-name-cell" role="cell"><strong title={taskDisplayName(task)}>{taskDisplayName(task)}</strong><small title={task.source_dir}>{taskSourceLabel(task)}</small><small>检索词：{task.search_text}</small></span>
                  <span className="al-task-status-cell" role="cell">
                    <span className={`al-badge al-badge-${statusView.tone}`}>{statusView.label}</span>
                    {cleanupView && <span className={`al-badge al-badge-${cleanupView.tone}`}>{cleanupView.label}</span>}
                    {task.cleanup_status === "cleanup_failed" && task.cleanup_error_summary && (
                      <small className="al-task-cleanup-error" title={task.cleanup_error_summary}>{task.cleanup_error_summary}</small>
                    )}
                  </span>
                  <span className="al-task-result-cell" role="cell"><strong>{task.occurrence_count} 条命中</strong><small>{progress}</small></span>
                  <span className="al-task-updated-cell" role="cell" title={updatedAt || undefined}>{formatDateTime(updatedAt)}</span>
                  <span className="al-task-row-actions" role="cell">{primaryAction && <Button size="small" appearance="primary" disabled={batchBusy || primaryAction.disabled} onClick={primaryAction.onSelect}>{primaryAction.label}</Button>}{menuActions.length > 0 && (<Menu><MenuTrigger disableButtonEnhancement><Button size="small" disabled={batchBusy} aria-label={`${taskDisplayName(task)}更多操作`}>更多</Button></MenuTrigger><MenuPopover><MenuList>{TASK_ACTION_GROUPS.map((group, groupIndex) => { const groupActions = menuActions.filter((action) => action.group === group); if (groupActions.length === 0) return null; return <div key={group}>{groupIndex > 0 && menuActions.some((action) => TASK_ACTION_GROUPS.indexOf(action.group) < groupIndex) && <MenuDivider />}{groupActions.map((action) => <MenuItem key={action.id} disabled={action.disabled} className={action.danger ? "al-task-delete-menu-item" : undefined} onClick={action.onSelect}>{action.label}</MenuItem>)}</div>; })}</MenuList></MenuPopover></Menu>)}{task.cleanup_status === "cleanup_failed" && (<><Button size="small" disabled={batchBusy || deletingTaskId !== null} onClick={() => void retryCleanup(task.task_id)}>{deletingTaskId === task.task_id ? "正在重试…" : "重试清理"}</Button><Button size="small" disabled={batchBusy} onClick={() => void openCleanupDir(task.task_id)}>打开残留目录</Button></>)}</span>
                </div>
              );
            })}
          </div>
          <div className="al-task-center-pagination">
            <Text className="al-muted">第 {pageStart}–{pageEnd} 项，共 {total} 项</Text>
            <Button disabled={batchBusy || loading || pageIndex === 0} onClick={() => { setSelectedTaskIds(new Set()); setPageIndex((value) => Math.max(0, value - 1)); }}>上一页</Button>
            <Text>第 {pageIndex + 1} / {totalPages} 页</Text>
            <Button disabled={batchBusy || loading || pageIndex >= totalPages - 1} onClick={() => { setSelectedTaskIds(new Set()); setPageIndex((value) => Math.min(totalPages - 1, value + 1)); }}>下一页</Button>
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
      <Dialog open={batchDeleteTargets !== null} onOpenChange={(_event, data) => { if (!data.open && !batchBusy) setBatchDeleteTargets(null); }}>
        <DialogSurface className="al-task-batch-delete-dialog">
          <DialogBody>
            <DialogTitle>确认批量删除或重试清理？</DialogTitle>
            <DialogContent>
              <div className="al-task-delete-confirmation">
                <Text>已选择 {batchDeleteTargets?.length ?? 0} 个任务，其中 {batchDeleteConfirmationPreview.executable} 个可执行、{batchDeleteConfirmationPreview.skipped} 个将跳过。</Text>
                <Text>系统会按以下清单逐项重新核验状态并顺序执行；单项失败不会阻塞后续任务。</Text>
                <ul className="al-task-batch-delete-list">
                  {(batchDeleteTargets ?? []).map((task) => {
                    const eligibility = batchEligibility(task, "delete");
                    return (
                      <li key={task.task_id}>
                        <span aria-hidden="true">{eligibility.executable ? "✓" : "—"}</span>
                        <div><strong>{taskDisplayName(task)}</strong><small>{eligibility.label}：{eligibility.reason}</small></div>
                      </li>
                    );
                  })}
                </ul>
                <Text>将删除可执行任务的本地任务记录、OCR 结果、校对与导出记录及生成页面；清理失败项会重试其已登记残留目录。</Text>
                <Text weight="semibold">不会删除任何原始 PDF、DjVu、TIFF、JPEG 或 PNG 文件。</Text>
                <Text className="al-muted">已删除的本地派生数据无法恢复。</Text>
              </div>
            </DialogContent>
            <DialogActions>
              <Button disabled={batchBusy} onClick={() => setBatchDeleteTargets(null)}>取消</Button>
              <Button
                appearance="primary"
                className="al-task-delete-button"
                disabled={batchBusy || batchDeleteConfirmationPreview.executable === 0}
                onClick={() => void executeBatch("delete", (batchDeleteTargets ?? []).map((task) => ({ taskId: task.task_id, taskName: taskDisplayName(task) })))}
              >{batchBusy ? "正在逐项处理…" : "按清单执行"}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
