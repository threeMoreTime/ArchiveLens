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
const searchPage = source("pages/SearchPage.tsx");
const reviewHighlightSettings = source("components/ReviewHighlightSettings.tsx");
const layoutContextCanvas = source("components/LayoutContextCanvas.tsx");
const exportPage = source("pages/ExportPage.tsx");
const taskCenter = source("pages/TaskCenter.tsx");
const developerPage = source("pages/DeveloperPage.tsx");
const developerTrigger = source("components/DeveloperModeTrigger.tsx");
const diagnosticErrorNotice = source("components/DiagnosticErrorNotice.tsx");
const settingsPage = source("pages/SettingsPage.tsx");
const scriptSearchSettings = source("components/ScriptSearchSettings.tsx");
const reviewShortcutSettings = source("components/ReviewShortcutSettings.tsx");
const styles = source("styles.css");

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

  it("侧栏把全局入口与当前任务工作区分成独立语义区域", () => {
    expect(app).toContain('aria-label="全局导航"');
    expect(app).toContain('aria-label="当前任务工作区"');
    expect(app).toContain('aria-label="当前任务导航"');
    expect(app).toContain("activeTaskDisplayName");
    expect(app).toContain("从任务中心选择任务");
    expect(styles).toContain(".al-task-nav-section");
    expect(styles).toContain(".al-task-nav-context");
  });

  it("全局菜单可折叠并记忆状态，同时移除任务提示卡片", () => {
    expect(app).toContain("SIDEBAR_COLLAPSED_STORAGE_KEY");
    expect(app).toContain("archivelens.sidebarCollapsed");
    expect(app).toContain('sidebarCollapsed ? " collapsed" : ""');
    expect(app).toContain('aria-label={sidebarCollapsed ? "展开菜单" : "收起菜单"}');
    expect(app).toContain("aria-expanded={!sidebarCollapsed}");
    expect(app).toContain("PanelLeftExpandRegular");
    expect(app).toContain("PanelLeftContractRegular");
    expect(app).toContain('title={sidebarCollapsed ? "首页" : undefined}');
    expect(app).not.toContain("al-recoverable");
    expect(app).not.toContain("al-sidebar-task");
    expect(styles).toContain(".al-sidebar.collapsed { width:64px");
  });

  it("切换页面时仅重置主内容区滚动位置", () => {
    expect(app).toContain("useLayoutEffect");
    expect(app).toContain("mainRef.current");
    expect(app).toContain("main.scrollTop = 0");
    expect(app).toContain("main.scrollLeft = 0");
    expect(app).toContain("[location.pathname]");
    expect(app).toContain('<main id="main-content" tabIndex={-1} ref={mainRef}');
    expect(app).toContain('className="al-skip-link"');
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
    expect(newScan).toContain("effective_preferences");
    expect(newScan).toContain("review_preferences: reviewPreferences");
    expect(newScan).toContain("出处页显示<strong>源文件无损</strong>");
    expect(newScan).toContain("LAYOUT_MODE_LABELS[reviewPreferences.layout_mode]");
    expect(newScan).toContain("可在校对工作台按页修正");
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

  it("校对页使用永久序号、可调三列工作区和顶部任务进度", () => {
    expect(reviewPage).toContain("al-review-taskbar");
    expect(reviewPage).toContain("al-review-progress-track");
    expect(reviewPage).toContain("reviewSummary.reviewed_count");
    expect(reviewPage).toContain("reviewSummary.unreviewed_count");
    expect(reviewPage).toContain("confidenceLabel(selected.ocr_confidence)");
    expect(reviewPage).toContain("void goToExport()");
    expect(reviewPage).toContain("系统判断");
    expect(reviewPage).toContain("人工结论");
    expect(reviewPage).toContain("版面 OCR 上下文");
    expect(reviewPage).toContain("LayoutContextCanvas");
    expect(reviewPage).toContain("window.archiveLens.review.getLayoutContext");
    expect(reviewPage).toContain("window.archiveLens.review.previewLayoutContext");
    expect(reviewPage).toContain("window.archiveLens.review.updateLayoutOverride");
    expect(reviewPage).toContain("window.archiveLens.review.rebuildLayoutContexts");
    expect(reviewPage).toContain("版面结构待确认");
    expect(reviewPage).toContain("global_sequence");
    expect(reviewPage).toContain("sequenceLabel(item.global_sequence)");
    expect(reviewPage).toContain("al-review-image-pane");
    expect(reviewPage).toContain("al-review-resizer");
    expect(reviewPage).toContain("useVirtualizer");
    expect(reviewPage).toContain("al-result-filters");
    expect(reviewPage).not.toContain("al-review-aside");
    expect(reviewPage).not.toContain("al-review-summary");
    expect(reviewPage).not.toContain("summaryCollapsed");
    expect(reviewPage).not.toContain("PanelRightExpandRegular");
    expect(reviewPage).toContain('role="listbox"');
    expect(reviewPage).toContain("NOTE_DRAFT_PREFIX");
    expect(reviewPage).toContain("if (!(await flushCurrentNote()) || reviewContextRef.current !== operationContext) return");
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
    expect(reviewHighlightSettings).not.toContain("QUALITY_OPTIONS");
    expect(reviewHighlightSettings).toContain("LAYOUT_MODE_OPTIONS");
    expect(reviewHighlightSettings).not.toContain("ArchiveQualitySample");
    expect(reviewHighlightSettings).toContain("ArchiveLayoutSample");
    expect(reviewHighlightSettings).toContain("命中列居中");
    expect(reviewHighlightSettings).toContain("命中行居中");
    expect(reviewHighlightSettings).toContain("layout_mode");
    expect(reviewHighlightSettings).not.toContain("context_radius");
    expect(reviewHighlightSettings).not.toContain("context_direction");
    expect(reviewHighlightSettings).toContain("出处页始终按源文件无损显示");
    expect(styles).toContain("grid-template-columns:minmax(320px,calc(var(--al-image-pane) - 4px))");
    expect(styles).toContain("@media (max-width:1180px)");
    expect(styles).toContain("white-space:pre-wrap");
  });

  it("任务内检索提供简繁范围、持久历史、分层证据和原图人工核查", () => {
    expect(app).toContain('path="/search/:taskId"');
    expect(app).toContain('to={`/search/${currentTaskId}`}');
    expect(taskPage).toContain('nav(`/search/${taskId}`)');
    expect(taskPage).toContain("legacy_requires_reocr");
    expect(searchPage).toContain("window.archiveLens.search.execute");
    expect(searchPage).toContain("window.archiveLens.search.listSessions");
    expect(searchPage).toContain("window.archiveLens.search.queryHits");
    expect(searchPage).toContain("window.archiveLens.search.preparePageImage");
    expect(searchPage).toContain("只命中简体");
    expect(searchPage).toContain("只命中繁体");
    expect(searchPage).toContain("简体和繁体");
    expect(searchPage).toContain("OCR 原文（不可变）");
    expect(searchPage).toContain("低置信候选");
    expect(searchPage).toContain("版面 OCR 上下文");
    expect(searchPage).toContain("LayoutContextCanvas");
    expect(searchPage).toContain("不能静默迁移");
    expect(searchPage).toContain("不修改 OCR 原文");
    expect(styles).toContain(".al-search-highlight");
    expect(styles).toContain(".al-search-layer-ocr-top-k");
  });

  it("移除清晰度档位并保留可折叠、可联动的版面模式样例", () => {
    expect(reviewHighlightSettings).not.toContain("qualityExpanded");
    expect(reviewHighlightSettings).toContain("layoutExpanded");
    expect(reviewHighlightSettings).not.toContain("aria-expanded={qualityExpanded}");
    expect(reviewHighlightSettings).toContain("aria-expanded={layoutExpanded}");
    expect(reviewHighlightSettings).not.toContain("以下为清晰度示意");
    expect(reviewHighlightSettings).not.toContain("al-quality-magnifier");
    expect(styles).not.toContain("al-archive-quality-sample");
    expect(styles).not.toContain(".quality-standard");
    expect(reviewHighlightSettings).toContain("ArchiveLayoutSample mode={option.value}");
    expect(reviewHighlightSettings).toContain("自动识别不确定时不会拼接可疑内容");
    expect(reviewHighlightSettings).toContain("可在校对工作台按页修正版块");
    expect(styles).toContain(".al-review-option-grid label:focus-within");
    expect(styles).toContain(".al-review-preference-toggle:focus-visible");
    expect(styles).toContain(".al-layout-mode-sample.horizontal");
    expect(styles).toContain(".al-layout-mode-sample.vertical");
    expect(styles).toContain(".al-layout-mode-sample.auto");
    expect(layoutContextCanvas).toContain("context.items.map");
    expect(layoutContextCanvas).toContain("<mark>{item.text.slice(start, end)}</mark>");
    expect(styles).toContain("writing-mode:vertical-rl");
    expect(styles).toContain("overflow:auto");
  });

  it("设置页集中承载显示偏好，并把技术诊断迁入隐藏开发者入口", () => {
    expect(app).toContain('to="/settings"');
    expect(app).toContain('path="/settings"');
    expect(app).not.toContain('to="/diagnostics"');
    expect(settingsPage).toContain("ReviewHighlightSettings");
    expect(settingsPage).toContain("ScriptSearchSettings");
    expect(scriptSearchSettings).toContain("只命中简体");
    expect(scriptSearchSettings).toContain("只命中繁体");
    expect(scriptSearchSettings).toContain("简体和繁体");
    expect(scriptSearchSettings).toContain("search_script_scope");
    expect(scriptSearchSettings).toContain("绝不会覆盖 OCR 原文");
    expect(settingsPage).toContain("loadAllTasks");
    expect(settingsPage).toContain("currentTaskId");
    expect(reviewHighlightSettings).toContain("全局默认");
    expect(reviewHighlightSettings).toContain("指定任务");
    expect(reviewHighlightSettings).toContain("选择任务");
    // 环境诊断入口已移除，改为隐藏开发者入口（未解锁不渲染开发者按钮）
    expect(settingsPage).not.toContain('nav("/diagnostics")');
    expect(settingsPage).not.toContain("打开环境诊断");
    expect(settingsPage).not.toContain("打开日志目录");
    expect(settingsPage).not.toContain("localData.user_data_path");
    expect(settingsPage).toContain("DeveloperModeTrigger");
    expect(settingsPage).toContain("developerEnabled &&");
    expect(settingsPage).toContain('nav("/settings/developer")');
  });

  it("导出页读取任务全量结果，并使用受限的预加载导出 API", () => {
    expect(exportPage).toContain("window.archiveLens.tasks.get(taskId)");
    expect(exportPage).toContain("window.archiveLens.results.query");
    expect(exportPage).toContain("window.archiveLens.export.create");
    expect(exportPage).toContain("window.archiveLens.export.listJobs");
    expect(exportPage).toContain("window.archiveLens.export.list");
    expect(exportPage).toContain("awaitingConfirmation");
    expect(exportPage).not.toContain("window.confirm");
    expect(exportPage).toContain("而非当前校对页或已加载的项目");
    expect(exportPage).toContain('selectedFormat === "html" || !summary.scan_complete || !summary.review_complete');
    expect(exportPage).toContain("报告包含大量页面图片，文件可能超过 300MB，打开、搜索和打印可能较慢");
    expect(exportPage).toContain("仍然导出 HTML");
    expect(exportPage).toContain('event.event === "export.progress"');
    expect(exportPage).toContain('event.event === "export.cleanup"');
    expect(exportPage).toContain("正在处理页面图片");
    expect(exportPage).toContain('job.status !== "queued" && ACTIVE_JOB.has(job.status)');
    expect(exportPage).toContain('job.export_id !== activeJob?.export_id');
  });

  it("切换导出任务时不会沿用上一任务的导出成功状态", () => {
    expect(exportPage).toContain("setJobs([]);");
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
    expect(taskCenter).toContain("选择当前页");
    expect(taskCenter).toContain("批量暂停");
    expect(taskCenter).toContain("批量取消");
    expect(taskCenter).toContain("批量删除");
    expect(taskCenter).toContain("batchEligibility(current, action)");
    expect(taskCenter).toContain("const boundedTargets = targets.slice(0, PAGE_SIZE)");
    expect(taskCenter).toContain("batchRunRef.current");
    expect(taskCenter).toContain("window.archiveLens.tasks.get(target.taskId)");
    expect(taskCenter).toContain("重试失败项");
    expect(taskCenter).toContain("不会删除任何原始 PDF、DjVu、TIFF、JPEG 或 PNG 文件");
    expect(taskCenter).toContain('className="al-task-status-cell"');
    expect(taskCenter).toContain('className="al-task-updated-cell"');
    expect(styles).toContain('grid-template-areas:"select task actions"');
    expect(styles).toContain("@media (max-width: 1180px)");
  });

  it("检索历史按词语和字形范围折叠，并复用同一语料版本", () => {
    expect(searchPage).toContain("dedupeSearchSessions(history.items)");
    expect(searchPage).toContain("findReusableSearchSession");
    expect(searchPage).toContain("prependSearchSession");
    expect(searchPage).toContain("没有新增重复历史");
    expect(searchPage).toContain("{sessions.length} 组");
  });

  it("设置页允许无冲突地改写校对单键，并声明固定组合键", () => {
    expect(settingsPage).toContain("ReviewShortcutSettings");
    expect(reviewShortcutSettings).toContain("normalizeReviewShortcutKey");
    expect(reviewShortcutSettings).toContain("storeReviewShortcutBindings");
    expect(reviewShortcutSettings).toContain("已用于");
    expect(reviewShortcutSettings).toContain("Ctrl+Shift+Z");
    expect(reviewPage).toContain("readReviewShortcutBindings");
    expect(reviewPage).toContain("getReviewShortcutAction(event, shortcutBindings)");
    expect(styles).toContain("@media (prefers-reduced-motion:reduce)");
    expect(styles).toContain("@media (forced-colors:active)");
  });

  it("开发者页面承载技术诊断、复制入口、DevTools 与退出，且默认折叠原始 JSON", () => {
    expect(developerPage).toContain("重新诊断");
    expect(developerPage).toContain("复制诊断摘要");
    expect(developerPage).toContain("复制含完整路径信息");
    expect(developerPage).toContain("复制 AI 错误调试信息");
    expect(developerPage).toContain("打开日志目录");
    expect(developerPage).toContain("打开本地数据目录");
    expect(developerPage).toContain("打开渲染器开发者工具");
    expect(developerPage).toContain("退出开发者模式");
    expect(developerPage).toContain("window.archiveLens.app.getDeveloperSnapshot");
    expect(developerPage).toContain("window.archiveLens.app.copyAiDebugInfo");
    expect(developerPage).toContain("window.archiveLens.app.openRendererDevTools");
    expect(developerPage).toContain("window.archiveLens.settings.getDeveloperMode");
    // 进入时重新校验开发者模式，未启用则 replace 到 /settings
    expect(developerPage).toContain('nav("/settings", { replace: true })');
    // 原始 JSON 默认折叠、使用 details/pre，且不渲染日志正文
    expect(developerPage).toContain("<details className=\"al-developer-raw\">");
    expect(developerPage).toContain("al-developer-raw-pre");
    // 确认框使用 Fluent Dialog，不得使用 window.confirm
    expect(developerPage).toContain("<Dialog");
    expect(developerPage).not.toContain("window.confirm");
    expect(developerPage).toContain("复制含完整路径的诊断信息？");
    expect(developerPage).toContain("复制完整 AI 错误调试信息？");
    expect(developerPage).toContain("只写入本机剪贴板，不会自动发送");
    // 读取校对页记录的 occurrence ID
    expect(developerPage).toContain("archivelens.lastReviewOccurrence.");
  });

  it("隐藏开发者入口按 3 秒内连点 7 次解锁，并逐步提示剩余次数", () => {
    expect(developerTrigger).toContain("REQUIRED_TAPS = 7");
    expect(developerTrigger).toContain("RESET_WINDOW_MS = 3000");
    expect(developerTrigger).toContain("再点击 ${REQUIRED_TAPS - count} 次进入开发者模式");
    expect(developerTrigger).toContain("已进入开发者模式");
    expect(developerTrigger).toContain("window.archiveLens.settings.setDeveloperMode({ enabled: true })");
    expect(developerTrigger).toContain('aria-live="polite"');
  });

  it("统一诊断错误组件只渲染业务信息，原始错误只上报", () => {
    expect(diagnosticErrorNotice).toContain("reportRendererError");
    expect(diagnosticErrorNotice).toContain("copyDiagnosticSummary");
    expect(diagnosticErrorNotice).toContain("issue.what");
    expect(diagnosticErrorNotice).toContain("issue.impact");
    expect(diagnosticErrorNotice).toContain("issue.remedy");
    expect(diagnosticErrorNotice).toContain("issue.code");
    expect(diagnosticErrorNotice).not.toContain("issue.rawMessage}");
  });

  it("普通页面不再出现 OCR 模型、绝对运行路径与原始 stage/type/error", () => {
    expect(taskPage).not.toContain("统一 OCR 模型");
    expect(taskPage).not.toContain("task.ocr_model_id");
    expect(taskPage).not.toContain("task.error_message");
    expect(taskPage).not.toContain("failure.error_type");
    expect(taskPage).not.toContain("failure.stage");
    expect(taskPage).not.toContain('nav("/diagnostics")');
    expect(taskPage).not.toContain("openLogDirectory");
    expect(taskPage).toContain("DiagnosticErrorNotice");
    expect(taskPage).toContain("TASK_SCAN_PARTIAL");
    // 导出页移除完整输出路径与原始错误
    expect(exportPage).not.toContain("job.error_message");
    expect(exportPage).not.toContain("job.cleanup_error_message");
    expect(exportPage).not.toContain("title={job.output_path}");
    expect(exportPage).not.toContain("title={item.path}");
    expect(exportPage).toContain("EXPORT_JOB_FAILED");
    // 首页移除逐组件环境摘要与诊断入口
    expect(welcome).not.toContain('nav("/diagnostics")');
    expect(welcome).not.toContain("环境摘要");
    expect(welcome).toContain("DiagnosticErrorNotice");
    // 置信度统一整数百分比
    expect(reviewPage).toContain("Math.round(value * 100)}%");
    expect(reviewPage).not.toContain("value.toFixed(2)");
    expect(searchPage).toContain("Math.round(selected.line_confidence * 100)}%");
    expect(searchPage).not.toContain("line_confidence.toFixed(3)");
    // 校对页移除“已加载 x/y”
    expect(reviewPage).not.toContain("已加载 ");
  });

  it("设置页透明展示本地明文、逐任务占用与安全临时清理边界", () => {
    expect(settingsPage).toContain("本地处理不等于应用级加密");
    expect(settingsPage).toContain("getLocalDataSummary");
    expect(settingsPage).toContain("各任务占用");
    expect(settingsPage).toContain("cleanupTemporaryData");
    expect(settingsPage).toContain("未知孤立目录不会被自动猜测删除");
    expect(settingsPage).toContain("卸载 ArchiveLens 默认保留本地数据");
  });
});
