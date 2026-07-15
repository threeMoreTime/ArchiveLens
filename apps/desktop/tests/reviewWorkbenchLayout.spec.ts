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
  it("校对路由使用固定视口，三栏不显示纵向滚动条", () => {
    expect(app).toContain('location.pathname.startsWith("/review/")');
    expect(app).toContain("al-main-review");
    expect(styles).toContain(".al-main-review { overflow:hidden;");
    expect(styles).toContain(".al-result-scroll::-webkit-scrollbar { display:none; }");
    expect(styles).toContain("scrollbar-width:none");
    expect(styles).toMatch(/\.al-detail \{[^}]*min-height:0;[^}]*overflow:hidden;/);
    expect(styles).toMatch(/\.al-review-aside \{[^}]*overflow:hidden;/);
    expect(styles).toContain("@media (max-height: 760px)");
  });

  it("摘要支持折叠并将用户选择保存到本地", () => {
    expect(reviewPage).toContain('REVIEW_SUMMARY_COLLAPSED_KEY');
    expect(reviewPage).toContain('localStorage.setItem(REVIEW_SUMMARY_COLLAPSED_KEY');
    expect(reviewPage).toContain('aria-label={summaryCollapsed ? "展开校对摘要" : "收起校对摘要"}');
    expect(reviewPage).toContain("al-review-aside collapsed");
    expect(reviewPage).toContain("al-review-aside-progress");
  });

  it("固定画布提供明确缩放工具，判断、导航和备注分组排列", () => {
    expect(reviewPage).toContain("ResizeObserver");
    expect(reviewPage).toContain("fitScale");
    expect(reviewPage).toContain('aria-label="缩小页面"');
    expect(reviewPage).toContain('aria-label="放大页面"');
    expect(reviewPage).toContain('>适应窗口</Button>');
    expect(reviewPage).toContain('>重新居中</Button>');
    expect(reviewPage).toContain("al-review-command-bar");
    expect(reviewPage).toContain("al-decision-actions");
    expect(reviewPage).toContain("al-navigation-actions");
    expect(reviewPage).toContain("al-review-note-panel");
  });
});
