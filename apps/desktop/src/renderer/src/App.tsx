import { NavLink, Route, Routes } from "react-router-dom";
import Welcome from "./pages/Welcome";
import NewScan from "./pages/NewScan";
import TaskPage from "./pages/TaskPage";
import ReviewPage from "./pages/ReviewPage";

export default function App() {
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
