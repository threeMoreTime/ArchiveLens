import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return readFileSync(path.resolve(__dirname, "../src/renderer/src", relativePath), "utf-8");
}

const welcome = source("pages/Welcome.tsx");
const newScan = source("pages/NewScan.tsx");
const taskPage = source("pages/TaskPage.tsx");
const reviewPage = source("pages/ReviewPage.tsx");
const exportPage = source("pages/ExportPage.tsx");

describe("桌面端产品化 UI contract", () => {
  it("首页使用真实任务与环境数据，而非硬编码任务列表", () => {
    expect(welcome).toContain("window.archiveLens.tasks.list");
    expect(welcome).toContain("window.archiveLens.app");
    expect(welcome).toContain("当前任务");
    expect(welcome).toContain("最近任务");
  });

  it("新建扫描展示三种来源，但明确单文件和多文件尚未接入任务协议", () => {
    expect(newScan).toContain('id: "single"');
    expect(newScan).toContain('id: "multiple"');
    expect(newScan).toContain('id: "folder"');
    expect(newScan).toContain("界面预览，未接入任务协议");
    expect(newScan).toContain('sourceMode === "folder"');
    expect(newScan).toContain('aria-label="检索文字或词语"');
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
  });

  it("导出页读取任务全量结果，并使用受限的预加载导出 API", () => {
    expect(exportPage).toContain("window.archiveLens.tasks.get(taskId)");
    expect(exportPage).toContain("window.archiveLens.results.query");
    expect(exportPage).toContain("window.archiveLens.export.json(taskId)");
    expect(exportPage).toContain("window.archiveLens.export.html(taskId)");
    expect(exportPage).toContain("而非当前校对页或已加载的项目");
  });
});
