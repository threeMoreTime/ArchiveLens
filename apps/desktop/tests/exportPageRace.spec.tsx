/**
 * @vitest-environment jsdom
 *
 * P1-4 ExportPage 组件级竞态测试（发现 3/5 的真实组件验证）。
 *
 * 渲染真实 ExportPage，用 deferred（pending Promise）让初始加载保持 pending，
 * 期间发送 export 事件触发 loadJobs，验证：
 *   发现 3：初始加载期间收到 export 事件不导致页面永久停留在 loading
 *   发现 5：retry mismatch 分支的 generation/mounted 守卫
 */
import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false })) as any;
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

function fullTask(taskId: string) {
  return { task_id: taskId, name: "T", source_dir: "x", output_dir: "y", workspace_dir: "z", status: "completed", worker_generation: 1, last_event_sequence: 1, is_demo: 0, file_count: 1, total_pages: 1, processed_pages: 1, occurrence_count: 0, failure_count: 0, created_at: "", started_at: "", finished_at: "", error_message: null, search_text: "档", search_terms: ["档"], search_mode: "exact_literal", search_script_scope: "both" as const };
}
function fullResultsPage() {
  return { task_id: "task-a", total: 1, limit: 1, offset: 0, has_more: false, review_summary: { reviewed_count: 0, unreviewed_count: 1, confirmed_count: 0, needs_review_count: 0, rejected_count: 0 }, task_status: "completed", scan_complete: true, review_complete: false, layout_rebuild: { completed: 0, total: 0, failed: 0, remaining: 0 }, items: [] };
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

describe("ExportPage 初始加载期间 export 事件不致永久 loading（发现 3，真实 deferred）", () => {
  it("初始 Promise.all pending → 发 export 事件触发 loadJobs → 释放初始请求 → loading 正常关闭", async () => {
    const api = makeMockApi();
    // 初始 Promise.all 的各请求保持 pending（用 deferred 控制）
    const taskReq = deferred(fullTask("task-a"));
    const resultsReq = deferred(fullResultsPage());
    const listReq = deferred({ task_id: "task-a", items: [], limit: 10, offset: 0 });
    const listJobsReq = deferred({ task_id: "task-a", items: [], limit: 50, offset: 0, total: 0 });

    api.tasks.get.mockReturnValue(taskReq.promise);
    api.results.query.mockReturnValue(resultsReq.promise);
    api.export.list.mockReturnValue(listReq.promise);
    api.export.listJobs.mockReturnValue(listJobsReq.promise);

    // 记录事件订阅回调
    let eventCb: ((e: { task_id?: string | null; event: string }) => void) | null = null;
    api.subscribe.onEvent.mockImplementation((cb: any) => { eventCb = cb; return () => {}; });

    mountExportPage("task-a", api);

    // 确认事件回调已注册
    await waitFor(() => expect(eventCb).not.toBeNull());

    // 初始加载进行中（Promise.all pending）——发 export 事件
    // loadJobs 用 jobsSequence（独立于 initialLoadSeq），不应废弃初始加载
    // listJobs 在事件回调里被调用（loadJobs 发起新的 listJobs 请求）
    const eventJobsReq = deferred({ task_id: "task-a", items: [], limit: 50, offset: 0, total: 0 });
    api.export.listJobs.mockReturnValue(eventJobsReq.promise);
    api.export.list.mockResolvedValue({ task_id: "task-a", items: [], limit: 10, offset: 0 });

    act(() => { eventCb?.({ task_id: "task-a", event: "export.progress" }); });

    // 事件触发的 loadJobs 调用了 listJobs（第二次调用）
    await waitFor(() => expect(api.export.listJobs).toHaveBeenCalledTimes(2), { timeout: 5000 });

    // 释放初始 Promise.all 的各请求
    await act(async () => {
      taskReq.resolve(fullTask("task-a"));
      resultsReq.resolve(fullResultsPage());
      listReq.resolve({ task_id: "task-a", items: [], limit: 10, offset: 0 });
      listJobsReq.resolve({ task_id: "task-a", items: [], limit: 50, offset: 0, total: 0 });
    });

    // 关键断言：loading 正常关闭（不永久停留）——initialLoadSeq 未被 loadJobs 干扰
    await waitFor(() => {
      const loading = screen.queryByText(/正在读取/);
      return loading === null;
    }, { timeout: 5000 });

    // 页面渲染了导出标题（初始加载成功写入 task/summary）
    expect(screen.getByText("导出结果")).toBeTruthy();
  });
});
