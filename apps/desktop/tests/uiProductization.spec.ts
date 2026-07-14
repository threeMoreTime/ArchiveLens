import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return readFileSync(path.resolve(__dirname, "../src/renderer/src", relativePath), "utf-8");
}

const welcome = source("pages/Welcome.tsx");
const app = source("App.tsx");
const newScan = source("pages/NewScan.tsx");
const taskPage = source("pages/TaskPage.tsx");
const reviewPage = source("pages/ReviewPage.tsx");
const reviewHighlightSettings = source("components/ReviewHighlightSettings.tsx");
const exportPage = source("pages/ExportPage.tsx");
const taskCenter = source("pages/TaskCenter.tsx");
const diagnosticsPage = source("pages/DiagnosticsPage.tsx");
const settingsPage = source("pages/SettingsPage.tsx");

describe("桌面端产品化 UI contract", () => {
  it("首页使用真实任务与环境数据，而非硬编码任务列表", () => {
    expect(welcome).toContain("window.archiveLens.tasks.list");
    expect(welcome).toContain("window.archiveLens.app");
    expect(welcome).toContain("当前任务");
    expect(welcome).toContain("最近任务");
  });

  it("侧栏任务上下文优先使用当前路由，并持久化用户最后选择", () => {
    expect(app).toContain("taskIdFromPath(location.pathname)");
    expect(app).toContain("CURRENT_TASK_STORAGE_KEY");
    expect(app).toContain("routeTaskId ?? rememberedTaskId");
    expect(app).toContain('const exportPath = currentTaskId ? `/export/${currentTaskId}` : "/export"');
    expect(app).toContain("<NavLink to={exportPath}");
  });

  it("新建扫描支持文件夹、单文件和多文件来源", () => {
    expect(newScan).toContain('id: "single"');
    expect(newScan).toContain('id: "multiple"');
    expect(newScan).toContain('id: "folder"');
    expect(newScan).toContain("dialog.selectFiles");
    expect(newScan).toContain("source_type: \"files\"");
    expect(newScan).toContain("MAX_SOURCE_FILES");
    expect(newScan).toContain("自动移除");
    expect(newScan).toContain("支持跨目录和格式混合选择");
    expect(newScan).toContain("SUPPORTED_SOURCE_FORMAT_LABEL");
    expect(newScan).toContain("图片会校验真实格式、尺寸和页数");
    expect(newScan).toContain('aria-label="检索文字或词语"');
    expect(newScan).toContain("startError");
    expect(taskPage).toContain('task.status === "draft"');
    expect(taskPage).toContain("启动任务");
    expect(taskPage).toContain("使用原文件清单新建任务");
  });

  it("任务页保留真实生命周期控制，并展示处理中状态", () => {
    expect(taskPage).toContain("window.archiveLens.tasks[kind]");
    expect(taskPage).toContain("正在请求暂停…");
    expect(taskPage).toContain("正在恢复…");
    expect(taskPage).toContain("正在取消…");
  });

  it("校对页以真实 summary 驱动右侧摘要与快捷键", () => {
    expect(reviewPage).toContain("al-review-aside");
    expect(reviewPage).toContain("reviewSummary.reviewed_count");
    expect(reviewPage).toContain("reviewSummary.unreviewed_count");
    expect(reviewPage).toContain("confidenceLabel(selected.ocr_confidence)");
    expect(reviewPage).toContain("导出中心");
    expect(reviewPage).toContain("系统判断：");
    expect(reviewPage).toContain("人工结论：");
    expect(reviewPage).toContain('role="listbox"');
    expect(reviewPage).toContain("NOTE_DRAFT_PREFIX");
    expect(reviewPage).toContain("if (!(await flushCurrentNote())) return");
    expect(reviewPage).toContain("--al-review-highlight");
    expect(reviewPage).toContain("window.archiveLens.settings.get(taskId)");
    expect(reviewPage).not.toContain("<ReviewHighlightSettings");
    expect(reviewHighlightSettings).toContain("HIGHLIGHT_PRESETS");
    expect(reviewHighlightSettings).toContain('scope: "global"');
    expect(reviewHighlightSettings).toContain('scope: "task"');
    expect(reviewHighlightSettings).toContain("恢复跟随全局");
    expect(reviewHighlightSettings).toContain("仅影响校对工作台显示");
    expect(reviewHighlightSettings).toContain('type="color"');
    expect(reviewHighlightSettings).toContain('type="range"');
  });

  it("设置页集中承载显示偏好，并从设置进入独立环境诊断页", () => {
    expect(app).toContain('to="/settings"');
    expect(app).toContain('path="/settings"');
    expect(app).not.toContain('to="/diagnostics"');
    expect(settingsPage).toContain("ReviewHighlightSettings");
    expect(settingsPage).toContain("loadAllTasks");
    expect(settingsPage).toContain("currentTaskId");
    expect(reviewHighlightSettings).toContain("全局默认");
    expect(reviewHighlightSettings).toContain("指定任务");
    expect(reviewHighlightSettings).toContain("选择任务");
    expect(settingsPage).toContain('nav("/diagnostics")');
    expect(settingsPage).toContain("打开环境诊断");
  });

  it("导出页读取任务全量结果，并使用受限的预加载导出 API", () => {
    expect(exportPage).toContain("window.archiveLens.tasks.get(taskId)");
    expect(exportPage).toContain("window.archiveLens.results.query");
    expect(exportPage).toContain("window.archiveLens.export.json(taskId)");
    expect(exportPage).toContain("window.archiveLens.export.html(taskId)");
    expect(exportPage).toContain("window.archiveLens.export.list");
    expect(exportPage).toContain("awaitingConfirmation");
    expect(exportPage).not.toContain("window.confirm");
    expect(exportPage).toContain("而非当前校对页或已加载的项目");
  });

  it("切换导出任务时不会沿用上一任务的导出成功状态", () => {
    expect(exportPage).toContain("setResult(null);");
  });

  it("任务中心用可扩展菜单承载生命周期操作和安全删除", () => {
    expect(taskCenter).toContain("query: query || undefined");
    expect(taskCenter).toContain("status: status || undefined");
    expect(taskCenter).toContain("al-task-center-search");
    expect(taskCenter).toContain("SearchRegular");
    expect(taskCenter).toContain("DocumentAddRegular");
    expect(taskCenter).toContain("offset: pageIndex * PAGE_SIZE");
    expect(taskCenter).toContain("response.total");
    expect(taskCenter).toContain("window.archiveLens.tasks.delete");
    expect(taskCenter).toContain("window.archiveLens.tasks[kind]");
    expect(taskCenter).toContain("暂停任务");
    expect(taskCenter).toContain("取消任务");
    expect(taskCenter).toContain("TASK_ACTION_GROUPS");
    expect(taskCenter).toContain("primaryActionId");
    expect(taskCenter).toContain("MenuTrigger");
    expect(taskCenter).toContain("al-task-delete-menu-item");
    expect(taskCenter).toContain("不会删除原始文件");
    expect(taskCenter).toContain("DELETABLE_STATUSES");
  });

  it("环境诊断展示影响、处理建议、重试和日志入口", () => {
    expect(diagnosticsPage).toContain("check.impact");
    expect(diagnosticsPage).toContain("check.remedy");
    expect(diagnosticsPage).toContain("runDiagnostics");
    expect(diagnosticsPage).toContain("openLogDirectory");
  });
});
