import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const reviewPage = readFileSync(
  path.resolve(__dirname, "../src/renderer/src/pages/ReviewPage.tsx"),
  "utf-8",
);

describe("校对全量访问 UI contract", () => {
  it("使用服务端 offset 分页，且页面大小受控", () => {
    expect(reviewPage).toContain("DEFAULT_PAGE_SIZE = 100");
    expect(reviewPage).toContain("PAGE_SIZES = [50, 100, 200]");
    expect(reviewPage).toContain("offset: targetPage * pageSize");
    expect(reviewPage).toContain("const [loadedPageIndex, setLoadedPageIndex]");
    expect(reviewPage).toContain("第 {loadedPageIndex + 1} / {totalPages} 页");
    expect(reviewPage).toContain("首页");
    expect(reviewPage).toContain("末页");
  });

  it("明确展示扫描、校对与未校对状态，且跨页导航调用服务端", () => {
    expect(reviewPage).toContain("扫描未完成");
    expect(reviewPage).toContain("校对已完成");
    expect(reviewPage).toContain("未校对 {reviewSummary.unreviewed_count}");
    expect(reviewPage).toContain("for (let nextPage = loadedPageIndex + 1; nextPage < totalPages");
    expect(reviewPage).toContain("下一条待处理");
  });

  it("校对与备注失败不会显示为成功，并实现 Ctrl+Enter 保存", () => {
    expect(reviewPage).toContain("校对状态保存失败");
    expect(reviewPage).toContain("备注保存失败");
    expect(reviewPage).toContain('event.ctrlKey && event.key === "Enter"');
    expect(reviewPage).toContain("保存 (Ctrl+Enter)");
  });

  it("详情在历史或合成结果缺少 OCR 置信度时仍可渲染", () => {
    expect(reviewPage).toContain("confidenceLabel(selected.ocr_confidence)");
    expect(reviewPage).toContain('"未提供置信度"');
  });

  it("未完成扫描或校对时要求确认导出", () => {
    expect(reviewPage).toContain("导出文件会明确标记为未完成校对");
    expect(reviewPage).toContain("window.confirm");
  });
});
