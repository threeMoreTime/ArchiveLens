import { useEffect, useState } from "react";
import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
import Welcome from "./pages/Welcome";
import NewScan from "./pages/NewScan";
import TaskPage from "./pages/TaskPage";
import ReviewPage from "./pages/ReviewPage";

export default function App() {
  const nav = useNavigate();
  const [recoverable, setRecoverable] = useState<unknown[]>([]);
  useEffect(() => {
    const off = window.archiveLens.subscribe.onRecoverable((tasks: unknown[]) => {
      setRecoverable(Array.isArray(tasks) ? tasks : []);
    });
    return off;
  }, []);

  const firstRecoverableTask = recoverable.find(
    (task) => typeof task === "object" && task !== null && "task_id" in task && typeof (task as any).task_id === "string",
  ) as { task_id: string } | undefined;
  const firstRecoverableTaskId = firstRecoverableTask?.task_id ?? null;

  return (
    <div className="al-app">
      <aside className="al-sidebar">
        <div className="al-brand">ArchiveLens</div>
        <nav>
          <NavLink to="/" className={({ isActive }) => "al-navlink" + (isActive ? " active" : "")}>
            首页
          </NavLink>
          <NavLink to="/scan/new" className={({ isActive }) => "al-navlink" + (isActive ? " active" : "")}>
            新建扫描
          </NavLink>
        </nav>
        {recoverable.length > 0 && (
          <div className="al-recoverable">
            发现 {recoverable.length} 个未完成任务
            <button onClick={() => firstRecoverableTaskId && nav(`/tasks/${firstRecoverableTaskId}`)} disabled={!firstRecoverableTaskId}>
              查看
            </button>
          </div>
        )}
      </aside>
      <main className="al-main">
        <Routes>
          <Route path="/" element={<Welcome />} />
          <Route path="/scan/new" element={<NewScan />} />
          <Route path="/tasks/:taskId" element={<TaskPage />} />
          <Route path="/review/:taskId" element={<ReviewPage />} />
        </Routes>
      </main>
    </div>
  );
}
