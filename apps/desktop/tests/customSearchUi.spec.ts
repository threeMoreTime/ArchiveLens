import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const RENDERER = path.resolve(__dirname, "../src/renderer/src/pages");

function page(name: string): string {
  return readFileSync(path.join(RENDERER, name), "utf-8");
}

describe("自定义检索词 UI wiring", () => {
  it("新建扫描要求并传递 search_text", () => {
    const source = page("NewScan.tsx");
    expect(source).toContain("检索文字或词语");
    expect(source).toContain("TaskCreateParamsSchema.safeParse");
    expect(source).toContain("SearchTextSchema.safeParse");
    expect(source).toContain("search_text: searchText");
    expect(source).toContain("请输入检索文字或词语");
    expect(source).toContain("<InlineFeedback>{searchError}</InlineFeedback>");
    expect(source).toContain("区分大小写");
    expect(source).toContain("sourceDir");
  });

  it("任务页从持久化任务展示检索词和匹配模式", () => {
    const source = page("TaskPage.tsx");
    expect(source).toContain("task.search_text");
    expect(source).toContain("task.search_mode");
    expect(source).toContain("LEGACY_TASK_REQUIRES_REVIEW");
    expect(source).toContain("使用原目录新建任务");
  });

  it("校对页显示 matched_text，且以页内淡红高亮替代截取图", () => {
    const source = page("ReviewPage.tsx");
    expect(source).toContain("matched_text");
    expect(source).toContain('searchMode === "legacy_fixed_pair"');
    expect(source).toContain('className="al-page-canvas"');
    expect(source).toContain('className="al-highlight"');
    expect(source).toContain('className="al-result-thumbnail"');
    expect(source).toContain('className="al-result-thumbnail-highlight"');
    expect(source).not.toContain('className="al-result-ctx"');
    expect(source).not.toContain("检索词截取");
  });

  it("欢迎页展示 Sidecar 启动和退出错误而不是永久检测中", () => {
    const source = page("Welcome.tsx");
    expect(source).toContain("env.startupError");
    expect(source).toContain("onEngineExit");
    expect(source).toContain("!error");
  });
});
