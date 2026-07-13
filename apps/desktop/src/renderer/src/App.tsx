import { useEffect, useState } from "react";
import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { ClipboardTaskListLtrRegular, DocumentAddRegular, EditRegular, HomeRegular, ShareRegular } from "@fluentui/react-icons";
import type { TaskSummary } from "../../preload/api";
import ExportPage from "./pages/ExportPage";
import Welcome from "./pages/Welcome";
import NewScan from "./pages/NewScan";
import TaskPage from "./pages/TaskPage";
import ReviewPage from "./pages/ReviewPage";

export default function App() {
  const nav = useNavigate();
  const [recoverable, setRecoverable] = useState<unknown[]>([]);
  const [latestTask, setLatestTask] = useState<TaskSummary | null>(null);
  useEffect(() => {
    const off = window.archiveLens.subscribe.onRecoverable((tasks: unknown[]) => {
      setRecoverable(Array.isArray(tasks) ? tasks : []);
    });
    return off;
  }, []);

  useEffect(() => {
    let active = true;
    const loadLatestTask = () => window.archiveLens.tasks.list({ limit: 1, offset: 0 })
      .then((response: { items: TaskSummary[] }) => {
        if (active) setLatestTask(response.items[0] ?? null);
      })
      .catch(() => { /* Engine may still be starting; navigation remains safely disabled. */ });
    void loadLatestTask();
    const off = window.archiveLens.subscribe.onEvent(() => { void loadLatestTask(); });
    return () => { active = false; off(); };
  }, []);

  const firstRecoverableTask = recoverable.find(
    (task) => typeof task === "object" && task !== null && "task_id" in task && typeof (task as any).task_id === "string",
  ) as { task_id: string } | undefined;
  const firstRecoverableTaskId = firstRecoverableTask?.task_id ?? null;
  const currentTaskId = firstRecoverableTaskId ?? latestTask?.task_id ?? null;

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
          {currentTaskId ? <NavLink to={`/tasks/${currentTaskId}`} className={({ isActive }) => "al-navlink" + (isActive ? " active" : "")}><ClipboardTaskListLtrRegular /> 任务</NavLink> : <span className="al-navlink disabled" aria-disabled="true"><ClipboardTaskListLtrRegular /> 任务</span>}
          {currentTaskId ? <NavLink to={`/review/${currentTaskId}`} className={({ isActive }) => "al-navlink" + (isActive ? " active" : "")}><EditRegular /> 校对</NavLink> : <span className="al-navlink disabled" aria-disabled="true"><EditRegular /> 校对</span>}
          <NavLink to="/export" className={({ isActive }) => "al-navlink" + (isActive ? " active" : "")}><ShareRegular /> 导出</NavLink>
        </nav>
        {recoverable.length > 0 && (
          <div className="al-recoverable">
            发现 {recoverable.length} 个未完成任务
            <button onClick={() => firstRecoverableTaskId && nav(`/tasks/${firstRecoverableTaskId}`)} disabled={!firstRecoverableTaskId}>
              查看
            </button>
          </div>
        )}
        {latestTask && <div className="al-sidebar-task" title={latestTask.name || latestTask.source_dir}><span>当前任务</span><strong>{latestTask.name || "扫描任务"}</strong><small>{latestTask.status === "completed" ? "扫描已完成" : latestTask.status}</small></div>}
      </aside>
      <main className="al-main">
        <Routes>
          <Route path="/" element={<Welcome />} />
          <Route path="/scan/new" element={<NewScan />} />
          <Route path="/tasks/:taskId" element={<TaskPage />} />
          <Route path="/review/:taskId" element={<ReviewPage />} />
          <Route path="/export" element={<ExportPage />} />
          <Route path="/export/:taskId" element={<ExportPage />} />
        </Routes>
      </main>
    </div>
  );
}
