import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = (file: string) => readFileSync(
  path.resolve(__dirname, `../src/renderer/src/${file}`),
  "utf-8",
);

const app = source("App.tsx");
const reviewPage = source("pages/ReviewPage.tsx");
const styles = source("styles.css");

describe("校对工作台固定视口与舒适操作契约", () => {
  it("校对路由使用固定视口，三列与进度窄栏各自控制滚动", () => {
    expect(app).toContain('location.pathname.startsWith("/review/")');
    expect(app).toContain("al-main-review");
    expect(styles).toContain(".al-main-review { overflow:hidden;");
    expect(styles).toContain(".al-result-scroll::-webkit-scrollbar { display:none; }");
    expect(styles).toContain("scrollbar-width:none");
    expect(styles).toContain("grid-template-columns:minmax(0,2fr) minmax(0,1fr) minmax(0,1fr) 56px");
    expect(styles).toMatch(/\.al-detail \{[^}]*min-height:0;[^}]*overflow-y:auto;/);
    expect(styles).toMatch(/\.al-review-aside \{[^}]*overflow:hidden;/);
    expect(styles).toContain("@media (max-height: 760px)");
  });

  it("移除可展开摘要，只保留永久待处理进度窄栏", () => {
    expect(reviewPage).not.toContain("REVIEW_SUMMARY_COLLAPSED_KEY");
    expect(reviewPage).not.toContain("展开校对摘要");
    expect(reviewPage).not.toContain("收起校对摘要");
    expect(reviewPage).toContain('className="al-review-aside"');
    expect(reviewPage).toContain("al-review-aside-collapsed-summary");
    expect(reviewPage).toContain("al-review-aside-progress");
    expect(reviewPage).toContain("待处理");
    expect(styles).toContain("writing-mode:vertical-rl");
  });

  it("固定画布提供明确缩放工具，判断、导航和备注分组排列", () => {
    expect(reviewPage).toContain("ResizeObserver");
    expect(reviewPage).toContain("review.preparePageImage");
    expect(reviewPage).toContain("}, 150)");
    expect(reviewPage).toContain("Math.min(4");
    expect(reviewPage).toContain("正在加载原始清晰度");
    expect(reviewPage).toContain("pageImage.overscale_warning");
    expect(reviewPage).not.toContain("scale(${zoom})");
    expect(styles).not.toContain("will-change:transform");
    expect(reviewPage).toContain('aria-label="缩小页面"');
    expect(reviewPage).toContain('aria-label="放大页面"');
    expect(reviewPage).toContain('>适应窗口</Button>');
    expect(reviewPage).toContain('>重新居中</Button>');
    expect(reviewPage).toContain("al-review-command-bar");
    expect(reviewPage).toContain("al-decision-actions");
    expect(reviewPage).toContain("al-navigation-actions");
    expect(reviewPage).toContain("al-review-note-panel");
  });

  it("每次切换命中默认以 100% 居中显示，适应窗口保持为手动操作", () => {
    expect(reviewPage).toContain("const fitWhenReadyRef = useRef(false)");
    expect(reviewPage).toMatch(/useEffect\(\(\) => \{[\s\S]*?setZoom\(1\);[\s\S]*?setOffset\(\{ x: 0, y: 0 \}\);[\s\S]*?\}, \[selected\?\.occurrence_id\]\);/);
    expect(reviewPage).toMatch(/setZoom\(Math\.min\(\s*1,/);
    expect(reviewPage).toContain("fitWhenReadyRef.current = true");
    expect(reviewPage).toContain('>100%</Button>');
  });

  it("四向展示共享同一旋转内容层并按源文件保存方向", () => {
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
    expect(reviewPage).toContain("orientationSwapsAxes ? result.height_100_css : result.width_100_css");
    expect(reviewPage).toContain("orientationSwapsAxes ? pageImage.height_100_css : pageImage.width_100_css");
    expect(reviewPage).toContain('className="al-page-positioner"');
    expect(reviewPage).toContain('className="al-page-canvas"');
    expect(reviewPage).toContain("rotate(${PAGE_ORIENTATION_DEGREES[pageOrientation]}deg)");
    expect(styles).toContain(".al-page-positioner { position:absolute; left:50%; top:50%; }");
    expect(styles).toContain(".al-page-canvas { position:absolute; left:50%; top:50%; transform-origin:center center; }");
    expect(styles).toContain(".al-viewer-overlays { position:absolute;");
    expect(styles).toContain("max-width:calc(100% - 20px)");
  });
});
