import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const reviewPage = readFileSync(
  path.resolve(__dirname, "../src/renderer/src/pages/ReviewPage.tsx"),
  "utf-8",
);
const exportPage = readFileSync(
  path.resolve(__dirname, "../src/renderer/src/pages/ExportPage.tsx"),
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

  it("横向状态摘要已移除，进度窄栏保留待处理数量，且跨页导航调用服务端", () => {
    expect(reviewPage).not.toContain("扫描未完成");
    expect(reviewPage).not.toContain("校对已完成");
    expect(reviewPage).toContain("reviewSummary.unreviewed_count");
    expect(reviewPage).toContain("待处理");
    expect(reviewPage).toContain('aria-label={`已校对 ${reviewSummary.reviewed_count}，共 ${total} 条`}');
    expect(reviewPage).toContain("for (let nextPage = loadedPageIndex + 1; nextPage < totalPages");
    expect(reviewPage).toContain("下一条待处理");
  });

  it("校对与备注失败不会显示为成功，并实现自动保存与 Ctrl+Enter 立即保存", () => {
    expect(reviewPage).toContain("校对状态保存失败");
    expect(reviewPage).toContain("备注保存失败");
    expect(reviewPage).toContain('event.ctrlKey && event.key === "Enter"');
    expect(reviewPage).toContain("persistNote");
    expect(reviewPage).toContain("停顿后自动保存");
    expect(reviewPage).toContain("立即保存 (Ctrl+Enter)");
  });

  it("详情在历史或合成结果缺少 OCR 置信度时仍可渲染", () => {
    expect(reviewPage).toContain("confidenceLabel(selected.ocr_confidence)");
    expect(reviewPage).toContain('"未提供置信度"');
  });

  it("校对页统一进入导出中心，未完成结果使用应用内确认", () => {
    expect(reviewPage).toContain(">导出中心</Button>");
    expect(reviewPage).not.toContain("window.confirm");
    expect(exportPage).toContain("仍然导出阶段性结果");
    expect(exportPage).toContain("setAwaitingConfirmation(true)");
    expect(exportPage).not.toContain("window.confirm");
  });
});
