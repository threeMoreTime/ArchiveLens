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
  it("使用服务端 offset 分块加载与虚拟列表，且块大小受控", () => {
    expect(reviewPage).toContain("RESULT_CHUNK_SIZE = 100");
    expect(reviewPage).toContain("limit: RESULT_CHUNK_SIZE");
    expect(reviewPage).toContain("offset: offsetValue");
    expect(reviewPage).toContain("const rowVirtualizer = useVirtualizer");
    expect(reviewPage).toContain("new Array<Occurrence | undefined>(response.total)");
    expect(reviewPage).not.toContain("PAGE_SIZES");
    expect(reviewPage).not.toContain("末页");
  });

  it("进度进入任务上下文栏，且跨块导航按需读取结果", () => {
    expect(reviewPage).not.toContain("扫描未完成");
    expect(reviewPage).not.toContain("校对已完成");
    expect(reviewPage).toContain("reviewSummary.unreviewed_count");
    expect(reviewPage).toContain("待处理");
    expect(reviewPage).toContain('aria-label={"已审核 " + String(reviewSummary.reviewed_count) + "，共 " + String(total) + " 条"}');
    expect(reviewPage).toContain("const ensureItemAt = useCallback");
    expect(reviewPage).toContain("const selectNextFrom = useCallback");
    expect(reviewPage).toContain("await ensureItemAt(index, seed)");
    expect(reviewPage).toContain("下一条待处理");
  });

  it("校对批量写入保持原子与幂等，备注失败不会显示为成功，并支持 Ctrl+Enter 立即保存", () => {
    expect(reviewPage).toContain('runDecisionChanges(changes, "after", "保存校对状态", operationContext)');
    expect(reviewPage).toContain("window.archiveLens.review.updateDecisions");
    expect(reviewPage).toContain("SESSION_PENDING_DECISION_OPERATIONS");
    expect(reviewPage).toContain("operation_id: operationId");
    expect(reviewPage).toContain("结果尚未确认");
    expect(reviewPage).not.toContain("本次修改未写入");
    expect(reviewPage).toContain("selectedBatchIds.size >= MAX_REVIEW_DECISION_CHANGES");
    expect(reviewPage).toContain("persistedDecisionChanges");
    expect(reviewPage).toContain("备注保存失败");
    expect(reviewPage).toContain('event.ctrlKey && event.key === "Enter"');
    expect(reviewPage).toContain("persistNote");
    expect(reviewPage).toContain("停顿后自动保存");
    expect(reviewPage).toContain("立即保存 Ctrl+Enter");
  });

  it("详情在历史或合成结果缺少 OCR 置信度时仍可渲染", () => {
    expect(reviewPage).toContain("confidenceLabel(selected.ocr_confidence)");
    expect(reviewPage).toContain('"未提供置信度"');
  });

  it("校对页统一进入导出中心，未完成结果使用应用内确认", () => {
    expect(reviewPage).toContain("const goToExport = async () =>");
    expect(reviewPage).toContain('>导出</Button>');
    expect(reviewPage).not.toContain("window.confirm");
    expect(exportPage).toContain("仍然导出阶段性结果");
    expect(exportPage).toContain("setAwaitingConfirmation(true)");
    expect(exportPage).not.toContain("window.confirm");
  });
});
