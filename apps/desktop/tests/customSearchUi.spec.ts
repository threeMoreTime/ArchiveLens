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
    expect(source).toContain("search_text: searchText");
    expect(source).toContain("请输入检索文字或词语");
  });

  it("任务页从持久化任务展示检索词和匹配模式", () => {
    const source = page("TaskPage.tsx");
    expect(source).toContain("task.search_text");
    expect(source).toContain("task.search_mode");
  });

  it("校对页显示 matched_text，且仅 legacy 任务显示简繁筛选", () => {
    const source = page("ReviewPage.tsx");
    expect(source).toContain("matched_text");
    expect(source).toContain('searchMode === "legacy_fixed_pair"');
    expect(source).toContain("检索词截取");
  });
});
