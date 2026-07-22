import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = (file: string) => readFileSync(
  path.resolve(__dirname, "../src/renderer/src/" + file),
  "utf-8",
);

const app = source("App.tsx");
const reviewPage = source("pages/ReviewPage.tsx");
const reviewWorkbench = source("utils/reviewWorkbench.ts");
const layoutContextCanvas = source("components/LayoutContextCanvas.tsx");
const styles = source("styles.css");

describe("专业审核工作台布局与交互契约", () => {
  it("审核路由使用独立侧栏偏好、固定视口和可调整三栏布局", () => {
    expect(app).toContain("WORKBENCH_SIDEBAR_COLLAPSED_STORAGE_KEY");
    expect(app).toContain('stored === null ? true : stored === "true"');
    expect(app).toContain("isWorkbenchRoute ? workbenchSidebarCollapsed : standardSidebarCollapsed");
    expect(styles).toContain(".al-main-review { overflow:hidden;");
    expect(reviewPage).toContain('className="al-review-resizer"');
    expect(reviewPage).toContain('role="separator"');
    expect(reviewPage).toContain("resizeReviewLayout");
    expect(reviewPage).toContain("--al-image-pane");
    expect(reviewWorkbench).toContain("archivelens.reviewLayout.v1");
    expect(styles).toContain("grid-template-columns:minmax(320px,calc(var(--al-image-pane) - 4px))");
  });

  it("默认窗口保持三栏，窄窗口使用详情抽屉而不是纵向堆叠", () => {
    expect(reviewPage).toContain("al-detail-drawer-toggle");
    expect(reviewPage).toContain("al-detail-drawer-backdrop");
    expect(reviewPage).toContain("drawer-open");
    expect(styles).toContain("@media (max-width:1180px)");
    expect(styles).toContain(".al-detail.drawer-open { transform:translateX(0); }");
    expect(styles).not.toMatch(/@media \(max-width:1180px\)[\s\S]*?\.al-review-body \{[^}]*grid-template-columns:1fr;[^}]*\}/);
  });

  it("任务、查询词、保存状态和进度集中在顶部上下文栏", () => {
    expect(reviewPage).toContain("al-review-taskbar");
    expect(reviewPage).toContain("taskDisplayName(task)");
    expect(reviewPage).toContain("reviewSummary.reviewed_count");
    expect(reviewPage).toContain("reviewSummary.unreviewed_count");
    expect(reviewPage).toContain("al-review-progress-track");
    expect(reviewPage).toContain("saveStateLabel");
    expect(reviewPage).not.toContain("al-review-aside");
    expect(reviewPage).not.toContain("writing-mode:vertical-rl");
    expect(layoutContextCanvas).toContain("LayoutContextCanvas");
  });

  it("结果使用分块虚拟滚动、永久位置和直接跳转，不再分页", () => {
    expect(reviewPage).toContain("useVirtualizer");
    expect(reviewPage).toContain("RESULT_CHUNK_SIZE = 100");
    expect(reviewPage).toContain("loadedChunkOffsetsRef");
    expect(reviewPage).toContain("rowVirtualizer.getVirtualItems()");
    expect(reviewPage).toContain("readReviewPosition(taskId)");
    expect(reviewPage).toContain("storeReviewPosition(taskId, selectedIndex)");
    expect(reviewPage).toContain("jumpToPosition");
    expect(reviewPage).toContain('(batchMode ? " batch-mode" : "")');
    expect(reviewPage).toContain("targetIndex !== selectedIndex");
    expect(reviewPage).toContain('role="listbox"');
    expect(reviewPage).toContain('role="option"');
    expect(reviewPage).not.toContain("al-pagination");
    expect(reviewPage).not.toContain("PAGE_SIZES");
  });

  it("首次进入页面适应整页，同页切换保留比例，跨页重新适应并预载下一页", () => {
    expect(reviewPage).toContain("const fitWhenReadyRef = useRef(true)");
    expect(reviewPage).toContain("const samePage = selectedPageKeyRef.current === selectedPageKey");
    expect(reviewPage).toContain("if (samePage) return");
    expect(reviewPage).toContain("calculateFitZoom");
    expect(reviewPage).toContain("togglePageView");
    expect(reviewPage).toContain("pageImagePreloadRef");
    expect(reviewPage).toContain("正在加载原始清晰度");
    expect(reviewPage).toContain("pageImage.overscale_warning");
    expect(reviewPage).toContain(">原始比例</Button>");
    expect(reviewPage).toContain(">适应页面</Button>");
    expect(reviewPage).toContain("al-page-evidence-sequence");
    expect(reviewPage).not.toContain("al-evidence-locator");
    expect(reviewPage).not.toContain("scale(" + "$" + "{zoom})");
  });

  it("版面上下文保留空间位置，并支持候选版块与自定义框选修正", () => {
    expect(reviewPage).toContain("版面 OCR 上下文");
    expect(reviewPage).toContain("LayoutContextCanvas");
    expect(reviewPage).toContain("layoutContext?.candidate_blocks");
    expect(reviewPage).toContain("al-layout-correction-surface");
    expect(reviewPage).toContain("normalized_block_bbox");
    expect(reviewPage).toContain("window.archiveLens.review.previewLayoutContext");
    expect(reviewPage).toContain("window.archiveLens.review.updateLayoutOverride");
    expect(layoutContextCanvas).toContain("item.bbox.x0 - context.bbox.x0");
    expect(layoutContextCanvas).toContain("item.bbox.y0 - context.bbox.y0");
    expect(layoutContextCanvas).toContain("<mark>{item.text.slice(start, end)}</mark>");
    expect(styles).toContain(".al-layout-context-viewport { min-height:180px");
    expect(styles).toContain(".al-layout-correction-surface");
  });

  it("四向展示共享旋转内容层并按源文件保存方向", () => {
    expect(reviewPage).toContain("up: 0");
    expect(reviewPage).toContain("right: 90");
    expect(reviewPage).toContain("down: 180");
    expect(reviewPage).toContain("left: 270");
    expect(reviewPage).toContain('aria-label="页面展示方向"');
    expect(reviewPage).toContain("aria-pressed={pageOrientation === option.value}");
    expect(reviewPage).toContain('scope: "document"');
    expect(reviewPage).toContain("document_id: documentId");
    expect(reviewPage).toContain("setPageOrientations(previousOrientations)");
    expect(reviewPage).toContain("已恢复上次保存的方向");
    expect(reviewPage).toContain("orientationSwapsAxes ? image.height_100_css : image.width_100_css");
    expect(reviewPage).toContain('className="al-page-positioner"');
    expect(reviewPage).toContain('className="al-page-canvas"');
    expect(reviewPage).toContain("PAGE_ORIENTATION_DEGREES[pageOrientation]");
    expect(styles).toContain(".al-page-positioner { position:absolute; left:50%; top:50%; }");
    expect(styles).toContain(".al-page-canvas { position:absolute; left:50%; top:50%; transform-origin:center center; }");
  });

  it("判断在本地保存确认后前进，批量操作和会话级撤销共享同一恢复路径", () => {
    expect(reviewPage).toContain("result = await window.archiveLens.review.updateDecisions");
    expect(reviewPage).toContain("SESSION_PENDING_DECISION_OPERATIONS");
    expect(reviewPage).toContain("responseMatchesRequest");
    expect(reviewPage).toContain("persistedDecisionChanges");
    expect(reviewPage).toContain("reviewContextRef");
    expect(reviewPage).toContain("decisionOperationRef");
    expect(reviewPage).toContain("const shouldAdvance = previousDecision === null");
    expect(reviewPage).toContain("selectNextFrom(anchorIndex + 1, true, seed)");
    expect(reviewPage).toContain("selectedBatchIds");
    expect(reviewPage).toContain("includeReviewedInBatch");
    expect(reviewPage).toContain("runDecisionChanges");
    expect(reviewPage).toContain("decisionHistoryRef");
    expect(reviewPage).toContain("SESSION_DECISION_HISTORY");
    expect(reviewPage).toContain('performHistory("undo")');
    expect(reviewPage).toContain('performHistory("redo")');
    expect(reviewPage).toContain("decision: change[target]");
    expect(reviewPage).toContain('direction === "undo" ? "before" : "after"');
  });
});
