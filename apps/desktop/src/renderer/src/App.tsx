import { useEffect, useMemo, useState } from "react";
import { NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { ClipboardTaskListLtrRegular, DocumentAddRegular, EditRegular, HomeRegular, SettingsRegular, ShareRegular } from "@fluentui/react-icons";
import type { TaskSummary } from "../../preload/api";
import ExportPage from "./pages/ExportPage";
import Welcome from "./pages/Welcome";
import NewScan from "./pages/NewScan";
import TaskPage from "./pages/TaskPage";
import ReviewPage from "./pages/ReviewPage";
import TaskCenter from "./pages/TaskCenter";
import DiagnosticsPage from "./pages/DiagnosticsPage";
import SettingsPage from "./pages/SettingsPage";
import { taskDisplayName, taskStatusView } from "./utils/presentation";

const CURRENT_TASK_STORAGE_KEY = "archivelens.currentTaskId";

function taskIdFromPath(pathname: string): string | null {
  const match = /^\/(?:tasks|review|export)\/([^/]+)$/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export default function App() {
  const nav = useNavigate();
  const location = useLocation();
  const [recoverable, setRecoverable] = useState<unknown[]>([]);
  const [latestTask, setLatestTask] = useState<TaskSummary | null>(null);
  const [rememberedTaskId, setRememberedTaskId] = useState<string | null>(() => localStorage.getItem(CURRENT_TASK_STORAGE_KEY));
  const [activeTask, setActiveTask] = useState<TaskSummary | null>(null);
  useEffect(() => {
    const off = window.archiveLens.subscribe.onRecoverable((tasks: unknown[]) => {
      setRecoverable(Array.isArray(tasks) ? tasks : []);
    });
    return off;
  }, []);

  useEffect(() => {
    let active = true;
    let refreshTimer: number | null = null;
    const loadLatestTask = () => window.archiveLens.tasks.list({ limit: 1, offset: 0 })
      .then((response: { items: TaskSummary[] }) => {
        if (active) setLatestTask(response.items[0] ?? null);
      })
      .catch(() => { /* Engine may still be starting; navigation remains safely disabled. */ });
    const scheduleLatestTask = () => {
      if (refreshTimer !== null) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void loadLatestTask();
      }, 350);
    };
    void loadLatestTask();
    const off = window.archiveLens.subscribe.onEvent(scheduleLatestTask);
    return () => { active = false; if (refreshTimer !== null) window.clearTimeout(refreshTimer); off(); };
  }, []);

  const firstRecoverableTask = recoverable.find(
    (task) => typeof task === "object" && task !== null && "task_id" in task && typeof (task as any).task_id === "string",
  ) as { task_id: string } | undefined;
  const firstRecoverableTaskId = firstRecoverableTask?.task_id ?? null;
  const routeTaskId = useMemo(() => taskIdFromPath(location.pathname), [location.pathname]);

  useEffect(() => {
    if (!routeTaskId) return;
    setRememberedTaskId(routeTaskId);
    localStorage.setItem(CURRENT_TASK_STORAGE_KEY, routeTaskId);
  }, [routeTaskId]);

  const currentTaskId = routeTaskId ?? rememberedTaskId ?? firstRecoverableTaskId ?? latestTask?.task_id ?? null;

  useEffect(() => {
    let alive = true;
    if (!currentTaskId) {
      setActiveTask(null);
      return () => { alive = false; };
    }
    setActiveTask(null);
    const loadActiveTask = () => window.archiveLens.tasks.get(currentTaskId)
      .then((task: TaskSummary) => { if (alive) setActiveTask(task); })
      .catch(() => {
        if (!alive) return;
        setActiveTask(null);
        if (!routeTaskId && rememberedTaskId === currentTaskId) {
          localStorage.removeItem(CURRENT_TASK_STORAGE_KEY);
          setRememberedTaskId(null);
        }
      });
    void loadActiveTask();
    const off = window.archiveLens.subscribe.onEvent((event: { task_id?: string | null }) => {
      if (event?.task_id === currentTaskId) void loadActiveTask();
    });
    return () => { alive = false; off(); };
  }, [currentTaskId, rememberedTaskId, routeTaskId]);

  const sidebarTask = activeTask ?? (latestTask?.task_id === currentTaskId ? latestTask : null);
  const exportPath = currentTaskId ? `/export/${currentTaskId}` : "/export";

  return (
    <div className="al-app">
      <aside className="al-sidebar">
        <div className="al-brand"><span className="al-brand-mark">◆</span> ArchiveLens</div>
        <nav>
          <NavLink to="/" className={({ isActive }) => "al-navlink" + (isActive ? " active" : "")}>
            <HomeRegular /> 首页
          </NavLink>
          <NavLink to="/scan/new" className={({ isActive }) => "al-navlink" + (isActive ? " active" : "")}>
            <DocumentAddRegular /> 新建扫描
          </NavLink>
          <NavLink to="/tasks" end className={({ isActive }) => "al-navlink" + (isActive ? " active" : "")}><ClipboardTaskListLtrRegular /> 任务中心</NavLink>
          {currentTaskId ? <NavLink to={`/tasks/${currentTaskId}`} className={({ isActive }) => "al-navlink" + (isActive ? " active" : "")}><ClipboardTaskListLtrRegular /> 任务详情</NavLink> : <span className="al-navlink disabled" aria-disabled="true"><ClipboardTaskListLtrRegular /> 任务详情</span>}
          {currentTaskId ? <NavLink to={`/review/${currentTaskId}`} className={({ isActive }) => "al-navlink" + (isActive ? " active" : "")}><EditRegular /> 校对</NavLink> : <span className="al-navlink disabled" aria-disabled="true"><EditRegular /> 校对</span>}
          <NavLink to={exportPath} className={({ isActive }) => "al-navlink" + (isActive ? " active" : "")}><ShareRegular /> 导出</NavLink>
        </nav>
        {recoverable.length > 0 && (
          <div className="al-recoverable">
            发现 {recoverable.length} 个未完成任务
            <button onClick={() => firstRecoverableTaskId && nav(`/tasks/${firstRecoverableTaskId}`)} disabled={!firstRecoverableTaskId}>
              查看
            </button>
          </div>
        )}
        <div className="al-sidebar-footer">
          {sidebarTask && <div className="al-sidebar-task" title={sidebarTask.source_dir}><span>当前任务</span><strong>{taskDisplayName(sidebarTask)}</strong><small>{taskStatusView(sidebarTask).label}</small></div>}
          <NavLink to="/settings" className={({ isActive }) => "al-navlink al-settings-navlink" + (isActive || location.pathname === "/diagnostics" ? " active" : "")}><SettingsRegular /> 设置</NavLink>
        </div>
      </aside>
      <main className="al-main">
        <Routes>
          <Route path="/" element={<Welcome />} />
          <Route path="/scan/new" element={<NewScan />} />
          <Route path="/tasks" element={<TaskCenter />} />
          <Route path="/tasks/:taskId" element={<TaskPage />} />
          <Route path="/review/:taskId" element={<ReviewPage />} />
          <Route path="/export" element={<ExportPage />} />
          <Route path="/export/:taskId" element={<ExportPage />} />
          <Route path="/diagnostics" element={<DiagnosticsPage />} />
          <Route path="/settings" element={<SettingsPage currentTaskId={currentTaskId} />} />
        </Routes>
      </main>
    </div>
  );
}
