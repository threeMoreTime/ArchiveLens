import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { ClipboardTaskListLtrRegular, DocumentAddRegular, EditRegular, HomeRegular, PanelLeftContractRegular, PanelLeftExpandRegular, SearchRegular, SettingsRegular, ShareRegular } from "@fluentui/react-icons";
import type { TaskSummary } from "../../preload/api";
import ExportPage from "./pages/ExportPage";
import Welcome from "./pages/Welcome";
import NewScan from "./pages/NewScan";
import TaskPage from "./pages/TaskPage";
import ReviewPage from "./pages/ReviewPage";
import SearchPage from "./pages/SearchPage";
import TaskCenter from "./pages/TaskCenter";
import DiagnosticsPage from "./pages/DiagnosticsPage";
import SettingsPage from "./pages/SettingsPage";
import { taskDisplayName } from "./utils/presentation";
import brandIconUrl from "../../../resources/icon-64.png";

const CURRENT_TASK_STORAGE_KEY = "archivelens.currentTaskId";
const SIDEBAR_COLLAPSED_STORAGE_KEY = "archivelens.sidebarCollapsed";
const WORKBENCH_SIDEBAR_COLLAPSED_STORAGE_KEY = "archivelens.workbenchSidebarCollapsed";

function taskIdFromPath(pathname: string): string | null {
  const match = /^\/(?:tasks|review|search|export)\/([^/]+)$/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function isRecoverableTask(task: unknown): task is { task_id: string } {
  if (typeof task !== "object" || task === null || !("task_id" in task)) return false;
  return typeof task.task_id === "string";
}

export default function App() {
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const [recoverable, setRecoverable] = useState<unknown[]>([]);
  const [latestTask, setLatestTask] = useState<TaskSummary | null>(null);
  const [activeTask, setActiveTask] = useState<TaskSummary | null>(null);
  const [rememberedTaskId, setRememberedTaskId] = useState<string | null>(() => localStorage.getItem(CURRENT_TASK_STORAGE_KEY));
  const [standardSidebarCollapsed, setStandardSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true"; } catch { return false; }
  });
  const [workbenchSidebarCollapsed, setWorkbenchSidebarCollapsed] = useState(() => {
    try {
      const stored = localStorage.getItem(WORKBENCH_SIDEBAR_COLLAPSED_STORAGE_KEY);
      return stored === null ? true : stored === "true";
    } catch {
      return true;
    }
  });
  const isWorkbenchRoute = location.pathname.startsWith("/review/") || location.pathname.startsWith("/search/");
  const sidebarCollapsed = isWorkbenchRoute ? workbenchSidebarCollapsed : standardSidebarCollapsed;
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

  const firstRecoverableTask = recoverable.find(isRecoverableTask);
  const firstRecoverableTaskId = firstRecoverableTask?.task_id ?? null;
  const routeTaskId = useMemo(() => taskIdFromPath(location.pathname), [location.pathname]);

  useEffect(() => {
    if (!routeTaskId) return;
    setRememberedTaskId(routeTaskId);
    localStorage.setItem(CURRENT_TASK_STORAGE_KEY, routeTaskId);
  }, [routeTaskId]);

  const currentTaskId = routeTaskId ?? rememberedTaskId ?? firstRecoverableTaskId ?? latestTask?.task_id ?? null;
  const activeTaskDisplayName = activeTask?.task_id === currentTaskId ? taskDisplayName(activeTask) : null;

  useEffect(() => {
    try { localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(standardSidebarCollapsed)); } catch { /* Keep the session state if storage is unavailable. */ }
  }, [standardSidebarCollapsed]);

  useEffect(() => {
    try { localStorage.setItem(WORKBENCH_SIDEBAR_COLLAPSED_STORAGE_KEY, String(workbenchSidebarCollapsed)); } catch { /* Keep the session state if storage is unavailable. */ }
  }, [workbenchSidebarCollapsed]);

  const toggleSidebar = () => {
    if (isWorkbenchRoute) setWorkbenchSidebarCollapsed((value) => !value);
    else setStandardSidebarCollapsed((value) => !value);
  };

  useEffect(() => {
    let alive = true;
    if (!currentTaskId) {
      setActiveTask(null);
      return () => { alive = false; };
    }
    const loadActiveTask = () => window.archiveLens.tasks.get(currentTaskId)
      .then((task) => {
        if (alive) setActiveTask(task);
      })
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

  const exportPath = currentTaskId ? `/export/${currentTaskId}` : "/export";

  useLayoutEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    main.scrollTop = 0;
    main.scrollLeft = 0;
  }, [location.pathname]);

  return (
    <div className="al-app">
      <a className="al-skip-link" href="#main-content">跳到主要内容</a>
      <aside className={"al-sidebar" + (sidebarCollapsed ? " collapsed" : "")}>
        <div className="al-brand-row">
          <div className="al-brand" title={sidebarCollapsed ? "ArchiveLens" : undefined}><img className="al-brand-icon" src={brandIconUrl} alt="" aria-hidden="true" /><span>ArchiveLens</span></div>
          <button
            type="button"
            className="al-sidebar-toggle"
            aria-label={sidebarCollapsed ? "展开菜单" : "收起菜单"}
            title={sidebarCollapsed ? "展开菜单" : "收起菜单"}
            aria-expanded={!sidebarCollapsed}
            onClick={toggleSidebar}
          >
            {sidebarCollapsed ? <PanelLeftExpandRegular /> : <PanelLeftContractRegular />}
          </button>
        </div>
        <nav className="al-nav-section al-global-nav" aria-label="全局导航">
          <NavLink to="/" aria-label={sidebarCollapsed ? "首页" : undefined} title={sidebarCollapsed ? "首页" : undefined} className={({ isActive }) => "al-navlink" + (isActive ? " active" : "")}>
            <HomeRegular /><span className="al-nav-label">首页</span>
          </NavLink>
          <NavLink to="/scan/new" aria-label={sidebarCollapsed ? "新建扫描" : undefined} title={sidebarCollapsed ? "新建扫描" : undefined} className={({ isActive }) => "al-navlink" + (isActive ? " active" : "")}>
            <DocumentAddRegular /><span className="al-nav-label">新建扫描</span>
          </NavLink>
          <NavLink to="/tasks" end aria-label={sidebarCollapsed ? "任务中心" : undefined} title={sidebarCollapsed ? "任务中心" : undefined} className={({ isActive }) => "al-navlink" + (isActive ? " active" : "")}><ClipboardTaskListLtrRegular /><span className="al-nav-label">任务中心</span></NavLink>
        </nav>
        {currentTaskId ? (
          <section className="al-task-nav-section" aria-label="当前任务工作区">
            <div className="al-task-nav-context" title={activeTaskDisplayName ?? "正在读取当前任务"}>
              <span className="al-task-context-mark" aria-hidden="true" />
              <span className="al-task-context-copy">
                <small>当前任务</small>
                <strong>{activeTaskDisplayName ?? "正在读取任务"}</strong>
              </span>
            </div>
            <nav className="al-nav-section" aria-label="当前任务导航">
              <NavLink to={`/tasks/${currentTaskId}`} aria-label={sidebarCollapsed ? "任务详情" : undefined} title={sidebarCollapsed ? "任务详情" : undefined} className={({ isActive }) => "al-navlink" + (isActive ? " active" : "")}><ClipboardTaskListLtrRegular /><span className="al-nav-label">任务详情</span></NavLink>
              <NavLink to={`/review/${currentTaskId}`} aria-label={sidebarCollapsed ? "校对" : undefined} title={sidebarCollapsed ? "校对" : undefined} className={({ isActive }) => "al-navlink" + (isActive ? " active" : "")}><EditRegular /><span className="al-nav-label">校对</span></NavLink>
              <NavLink to={`/search/${currentTaskId}`} aria-label={sidebarCollapsed ? "任务内检索" : undefined} title={sidebarCollapsed ? "任务内检索" : undefined} className={({ isActive }) => "al-navlink" + (isActive ? " active" : "")}><SearchRegular /><span className="al-nav-label">任务内检索</span></NavLink>
              <NavLink to={exportPath} aria-label={sidebarCollapsed ? "导出" : undefined} title={sidebarCollapsed ? "导出" : undefined} className={({ isActive }) => "al-navlink" + (isActive ? " active" : "")}><ShareRegular /><span className="al-nav-label">导出</span></NavLink>
            </nav>
          </section>
        ) : (
          <div className="al-task-nav-empty" aria-label="尚未选择当前任务">
            <span className="al-task-context-mark" aria-hidden="true" />
            <span className="al-task-context-copy"><small>任务工作区</small><strong>从任务中心选择任务</strong></span>
          </div>
        )}
        <div className="al-sidebar-footer">
          <NavLink to="/settings" aria-label={sidebarCollapsed ? "设置" : undefined} title={sidebarCollapsed ? "设置" : undefined} className={({ isActive }) => "al-navlink al-settings-navlink" + (isActive || location.pathname === "/diagnostics" ? " active" : "")}><SettingsRegular /><span className="al-nav-label">设置</span></NavLink>
        </div>
      </aside>
      <main id="main-content" tabIndex={-1} ref={mainRef} className={"al-main" + (isWorkbenchRoute ? " al-main-review" : "")}>
        <Routes>
          <Route path="/" element={<Welcome />} />
          <Route path="/scan/new" element={<NewScan />} />
          <Route path="/tasks" element={<TaskCenter />} />
          <Route path="/tasks/:taskId" element={<TaskPage />} />
          <Route path="/review/:taskId" element={<ReviewPage />} />
          <Route path="/search/:taskId" element={<SearchPage />} />
          <Route path="/export" element={<ExportPage />} />
          <Route path="/export/:taskId" element={<ExportPage />} />
          <Route path="/diagnostics" element={<DiagnosticsPage />} />
          <Route path="/settings" element={<SettingsPage currentTaskId={currentTaskId} />} />
        </Routes>
      </main>
    </div>
  );
}
