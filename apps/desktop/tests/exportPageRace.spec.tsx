/**
 * @vitest-environment jsdom
 *
 * P1-4 ExportPage 组件级竞态测试（发现 3 的真实组件验证）。
 *
 * 渲染真实 ExportPage，mock window.archiveLens 与路由参数，验证初始加载期间
 * 收到 export 事件触发 loadJobs 不会使页面永久停留在 loading（分离 sequence 后）。
 */
import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeEventListener: () => {}, onchange: null, dispatchEvent: () => false })) as any;
  }
  if (!(globalThis as any).ResizeObserver) {
    (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function makeMockApi() {
  return {
    tasks: { get: vi.fn(), openDirectory: vi.fn(() => Promise.resolve({ ok: true })) },
    results: { query: vi.fn() },
    export: {
      list: vi.fn(),
      listJobs: vi.fn(),
      create: vi.fn(),
      cancel: vi.fn(),
      retry: vi.fn(),
      openDirectory: vi.fn(() => Promise.resolve({ ok: true })),
    },
    subscribe: { onEvent: vi.fn(() => () => {}) },
  };
}

let ExportPageForTest: React.ComponentType;
beforeEach(async () => {
  const mod = await import("../src/renderer/src/pages/ExportPage");
  ExportPageForTest = mod.default;
});

function mountExportPage(taskId: string, api: ReturnType<typeof makeMockApi>) {
  (window as any).archiveLens = api;
  return render(
    <MemoryRouter initialEntries={[`/export/${taskId}`]}>
      <Routes>
        <Route path="/export/:taskId" element={<ExportPageForTest />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ExportPage 初始加载与 jobs 刷新 sequence 分离（发现 3，组件级）", () => {
  it("所有初始请求完成后 loading 关闭，期间 export 事件触发 loadJobs 不干扰初始加载", async () => {
    const api = makeMockApi();
    api.tasks.get.mockResolvedValue({ task_id: "task-a", name: "T", source_dir: "x", output_dir: "y", workspace_dir: "z", status: "completed", worker_generation: 1, last_event_sequence: 1, is_demo: 0, file_count: 1, total_pages: 1, processed_pages: 1, occurrence_count: 0, failure_count: 0, created_at: "", started_at: "", finished_at: "", error_message: null, search_text: "档", search_terms: ["档"], search_mode: "exact_literal", search_script_scope: "both" });
    api.results.query.mockResolvedValue({ task_id: "task-a", total: 1, limit: 1, offset: 0, has_more: false, review_summary: { reviewed_count: 0, unreviewed_count: 1, confirmed_count: 0, needs_review_count: 0, rejected_count: 0 }, task_status: "completed", scan_complete: true, review_complete: false, layout_rebuild: { completed: 0, total: 0, failed: 0, remaining: 0 }, items: [] });
    api.export.list.mockResolvedValue({ task_id: "task-a", items: [], limit: 10, offset: 0 });
    api.export.listJobs.mockResolvedValue({ task_id: "task-a", items: [], limit: 50, offset: 0, total: 0 });

    let eventCb: ((e: { task_id?: string | null; event: string }) => void) | null = null;
    api.subscribe.onEvent.mockImplementation((cb: any) => { eventCb = cb; return () => {}; });

    mountExportPage("task-a", api);

    // 初始加载期间发 export 事件（在 Promise.all resolve 前）
    await act(async () => {
      // 给 microtask 机会让 Promise.all 发起，但未 resolve
      await Promise.resolve();
      eventCb?.({ task_id: "task-a", event: "export.progress" });
    });

    // 等待初始加载完成——loading 应关闭
    await waitFor(() => {
      const loading = screen.queryByText(/正在读取/);
      return loading === null;
    }, { timeout: 3000 });

    // 关键断言：loading 已关闭（不永久停留）
    expect(screen.queryByText(/正在读取/)).toBeNull();
    // 页面渲染了导出标题（初始加载成功写入 task/summary）
    expect(screen.getByText("导出结果")).toBeTruthy();
  });
});
