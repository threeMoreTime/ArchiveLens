import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmptyState, InlineFeedback, LoadingState, PageHeader } from "../src/renderer/src/components/feedback";
import { ReviewShortcutSettings } from "../src/renderer/src/components/ReviewShortcutSettings";
import { archiveLensTheme } from "../src/renderer/src/theme";
import { REVIEW_SHORTCUT_OPTIONS } from "../src/renderer/src/utils/reviewShortcuts";

describe("renderer UI runtime contracts", () => {
  it("renders every configurable proofreading shortcut with its default binding", () => {
    const markup = renderToStaticMarkup(createElement(ReviewShortcutSettings));

    expect(markup).toContain('role="list"');
    expect(markup).toContain('aria-label="可自定义校对快捷键"');
    expect(markup).toContain("Ctrl+Shift+Z");
    for (const option of REVIEW_SHORTCUT_OPTIONS) {
      expect(markup, option.action).toContain(option.label);
      expect(markup, option.action).toContain(`更改${option.label}快捷键`);
    }
  });

  it("renders shared feedback states with the expected accessible roles", () => {
    const header = renderToStaticMarkup(createElement(PageHeader, {
      title: "校对工作台",
      description: "连续审核档案结果",
    }));
    const warning = renderToStaticMarkup(createElement(InlineFeedback, { tone: "warning" }, "需要人工核查"));
    const error = renderToStaticMarkup(createElement(InlineFeedback, { tone: "error" }, "保存失败"));
    const loading = renderToStaticMarkup(createElement(LoadingState, { label: "正在读取任务" }));
    const empty = renderToStaticMarkup(createElement(EmptyState, {
      title: "暂无结果",
      detail: "调整筛选条件后重试",
      action: { label: "清除筛选", onClick: () => undefined },
    }));

    expect(header).toContain("校对工作台");
    expect(header).toContain("连续审核档案结果");
    expect(warning).toContain('role="status"');
    expect(warning).toContain("al-feedback-warning");
    expect(error).toContain('role="alert"');
    expect(loading).toContain('aria-live="polite"');
    expect(empty).toContain("清除筛选");
  });

  it("keeps the Fluent theme aligned with the warm archival workbench palette", () => {
    expect(archiveLensTheme.colorNeutralBackground1).toBe("#FFFDF8");
    expect(archiveLensTheme.colorBrandBackground).toBe("#A54812");
    expect(archiveLensTheme.colorBrandBackgroundHover).toBe("#8A390E");
    expect(archiveLensTheme.colorNeutralForeground1).toBe("#2A2017");
    expect(archiveLensTheme.fontFamilyBase).toContain("Microsoft YaHei UI");
    expect(archiveLensTheme.borderRadiusLarge).toBe("12px");
  });
});
