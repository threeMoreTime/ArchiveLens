/**
 * @vitest-environment jsdom
 *
 * P1-4 ExportPage 组件级竞态测试（审查最终收口）。
 *
 * 发现 3：初始加载 deferred pending + export 事件触发 → loading 正常关闭
 * 发现 5：pending retry 切换路由 → mismatch 不污染新页面
 */
import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import React from "react";
import { render, screen, waitFor, act, cleanup } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";

// 竞态测试在大模块冷加载 + 全量并发 fork CPU 争用下偶发破默认 hookTimeout(10s)。
// 与 searchPageRace.spec.tsx 对齐，给首屏渲染与组件轮询充足的确定性窗口。
vi.setConfig({ hookTimeout: 30000, testTimeout: 30000 });

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false })) as any;
  }
  if (!(globalThis as any).ResizeObserver) {
    (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  }
  // jsdom 缺少 NodeFilter（TreeWalker API），testing-library 的 getByRole 需要。
  if (!(globalThis as any).NodeFilter) {
    (globalThis as any).NodeFilter = { SHOW_ALL: 0xFFFFFFFF, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 };
  }
});

afterEach(() => {
  cleanup();
  // 这些测试全程使用 real timers（组件轮询依赖真实 setInterval）；
  // cleanup() 触发 React effect cleanup，组件内的 setInterval/clearInterval 已停止。
  // 不无条件调用 vi.runOnlyPendingTimers()（未启用 fake timers 时会抛错）。
  vi.restoreAllMocks();
});

// 增强 deferred：跟踪 settled 状态，测试结束前断言全部 settle，避免 pending promise 残留。
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  let settled = false;
  const promise = new Promise<T>((res, rej) => {
    resolve = (v) => { settled = true; res(v); };
    reject = (r) => { settled = true; rej(r); };
  });
  return { promise, resolve, reject, get settled() { return settled; } };
}

/** flush microtask 队列，替代固定 setTimeout 等待。 */
function flushMicrotasks() {
  return act(async () => { await Promise.resolve(); });
}

function makeMockApi() {
  return {
    tasks: { get: vi.fn(), openDirectory: vi.fn(() => Promise.resolve({ ok: true })) },
    results: { query: vi.fn() },
    export: { list: vi.fn(), listJobs: vi.fn(), create: vi.fn(), cancel: vi.fn(), retry: vi.fn(), openDirectory: vi.fn(() => Promise.resolve({ ok: true })) },
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

function mountWithNavigator(taskId: string, api: ReturnType<typeof makeMockApi>) {
  (window as any).archiveLens = api;
  let navigateFn: ((to: string) => void) | null = null;
  const NavigatorBridge = () => { const nav = useNavigate(); navigateFn = (to: string) => nav(to); return null; };
  const utils = render(
    <MemoryRouter initialEntries={[`/export/${taskId}`]}>
      <NavigatorBridge />
      <Routes><Route path="/export/:taskId" element={<ExportPageForTest />} /></Routes>
    </MemoryRouter>,
  );
  return { ...utils, navigate: (to: string) => navigateFn!(to) };
}

describe("ExportPage 初始加载期间 export 事件不致永久 loading（发现 3，真实 deferred）", () => {
  it("初始 Promise.all pending → 发 export 事件触发 loadJobs → 释放初始请求 → loading 正常关闭", async () => {
    const api = makeMockApi();
    const taskReq = deferred(fullTask("task-a"));
    const resultsReq = deferred(fullResultsPage());
    const listReq = deferred({ task_id: "task-a", items: [], limit: 10, offset: 0 });
    const listJobsReq = deferred({ task_id: "task-a", items: [], limit: 50, offset: 0, total: 0 });

    api.tasks.get.mockReturnValue(taskReq.promise);
    api.results.query.mockReturnValue(resultsReq.promise);
    api.export.list.mockReturnValue(listReq.promise);
    api.export.listJobs.mockReturnValue(listJobsReq.promise);

    let eventCb: ((e: { task_id?: string | null; event: string }) => void) | null = null;
    api.subscribe.onEvent.mockImplementation((cb: any) => { eventCb = cb; return () => {}; });

    mountWithNavigator("task-a", api);
    await waitFor(() => expect(eventCb).not.toBeNull());

    // 初始加载进行中——发 export 事件
    const eventJobsReq = deferred({ task_id: "task-a", items: [], limit: 50, offset: 0, total: 0 });
    api.export.listJobs.mockReturnValue(eventJobsReq.promise);
    api.export.list.mockResolvedValue({ task_id: "task-a", items: [], limit: 10, offset: 0 });
    act(() => { eventCb?.({ task_id: "task-a", event: "export.progress" }); });

    // 事件触发的 loadJobs 调用了 listJobs（第 2 次）
    await waitFor(() => expect(api.export.listJobs).toHaveBeenCalledTimes(2), { timeout: 5000 });

    // 释放初始 Promise.all（含事件触发的 eventJobsReq，避免 pending 残留）
    await act(async () => {
      taskReq.resolve(fullTask("task-a"));
      resultsReq.resolve(fullResultsPage());
      listReq.resolve({ task_id: "task-a", items: [], limit: 10, offset: 0 });
      listJobsReq.resolve({ task_id: "task-a", items: [], limit: 50, offset: 0, total: 0 });
      eventJobsReq.resolve({ task_id: "task-a", items: [], limit: 50, offset: 0, total: 0 });
    });

    // 断言全部 deferred 已 settle（无 pending 残留）
    expect(taskReq.settled).toBe(true);
    expect(resultsReq.settled).toBe(true);
    expect(listReq.settled).toBe(true);
    expect(listJobsReq.settled).toBe(true);
    expect(eventJobsReq.settled).toBe(true);

    // loading 正常关闭
    await waitFor(() => expect(screen.queryByText(/正在读取/)).toBeNull(), { timeout: 5000 });
    expect(screen.getByText("导出结果")).toBeTruthy();
  });
});

describe("ExportPage pending retry 切换路由不污染新页面（发现 5，组件级）", () => {
  it("/export/A retry pending → navigate /export/B → 释放 retry（mismatch）→ B 不显示 mismatch 错误", async () => {
    const api = makeMockApi();
    api.tasks.get.mockResolvedValue(fullTask("task-a"));
    api.results.query.mockResolvedValue(fullResultsPage());
    api.export.list.mockResolvedValue({ task_id: "task-a", items: [], limit: 10, offset: 0 });
    api.export.listJobs.mockResolvedValue({ task_id: "task-a", items: [{ export_id: "exp-a", task_id: "task-a", format: "html", status: "failed", current_stage: "failed", progress_completed: 0, progress_total: 0, output_path: "", error_code: "X", error_message: "", cancel_requested: false, retry_of: "", cleanup_status: "completed" as const, cleanup_error_code: "", cleanup_error_message: "", cleanup_attempt_count: 0, created_at: "", started_at: "", finished_at: "" }], limit: 50, offset: 0, total: 1 });

    // retry 保持 pending
    const retryReq = deferred({ export_id: "exp-new", task_id: "task-a", format: "html", status: "queued", retry_of: "exp-a" });
    api.export.retry.mockReturnValue(retryReq.promise);

    const { navigate } = mountWithNavigator("task-a", api);
    await waitFor(() => expect(screen.getByRole("heading", { name: "导出结果" })).toBeTruthy(), { timeout: 5000 });

    // 点击"重新导出"触发 retry
    const retryButton = await waitFor(() => screen.getByRole("button", { name: /重新导出/ }), { timeout: 5000 });
    await act(async () => { retryButton.click(); });
    expect(api.export.retry).toHaveBeenCalledWith("exp-a");

    // 导航到 /export/B
    api.tasks.get.mockResolvedValue(fullTask("task-b"));
    api.results.query.mockResolvedValue({ ...fullResultsPage(), task_id: "task-b" });
    api.export.list.mockResolvedValue({ task_id: "task-b", items: [], limit: 10, offset: 0 });
    api.export.listJobs.mockResolvedValue({ task_id: "task-b", items: [], limit: 50, offset: 0, total: 0 });
    await act(async () => { navigate("/export/task-b"); });

    // 释放 retry 结果（task_id 仍为 task-a，与当前 task-b 不匹配）
    await act(async () => {
      retryReq.resolve({ export_id: "exp-new", task_id: "task-a", format: "html", status: "queued", retry_of: "exp-a" });
    });
    // flush microtask 替代固定 setTimeout，让组件处理 late-arriving result
    await flushMicrotasks();

    // 断言 retry deferred 已 settle
    expect(retryReq.settled).toBe(true);

    // 关键断言：B 页面不显示 mismatch 错误（generation 守卫阻止了 setActionIssue）
    expect(screen.queryByText(/归属异常/)).toBeNull();
    expect(screen.queryByText(/归属的任务与当前页面不一致/)).toBeNull();
  });
});

describe("ExportPage 切换任务后 busy 恢复（P1 hotfix，组件级）", () => {
  it("cancel pending → navigate A→B → B 的导出按钮恢复可用（busy=false）", async () => {
    const api = makeMockApi();
    api.tasks.get.mockResolvedValue(fullTask("task-a"));
    api.results.query.mockResolvedValue(fullResultsPage());
    api.export.list.mockResolvedValue({ task_id: "task-a", items: [], limit: 10, offset: 0 });
    api.export.listJobs.mockResolvedValue({ task_id: "task-a", items: [{ export_id: "exp-a", task_id: "task-a", format: "html", status: "queued", current_stage: "queued", progress_completed: 0, progress_total: 0, output_path: "", error_code: "", error_message: "", cancel_requested: false, retry_of: "", cleanup_status: "pending" as const, cleanup_error_code: "", cleanup_error_message: "", cleanup_attempt_count: 0, created_at: "", started_at: null, finished_at: null }], limit: 50, offset: 0, total: 1 });

    // cancel 保持 pending
    const cancelReq = deferred({ export_id: "exp-a", status: "cancelling" });
    api.export.cancel.mockReturnValue(cancelReq.promise);

    const { navigate } = mountWithNavigator("task-a", api);
    await waitFor(() => expect(screen.getByRole("heading", { name: "导出结果" })).toBeTruthy(), { timeout: 5000 });

    // 点击取消（触发 busy=true，cancel pending）
    const cancelButton = await waitFor(() => screen.getByRole("button", { name: /取消导出/ }), { timeout: 5000 });
    await act(async () => { cancelButton.click(); });
    expect(api.export.cancel).toHaveBeenCalledWith("exp-a");

    // 导航到 B
    api.tasks.get.mockResolvedValue(fullTask("task-b"));
    api.results.query.mockResolvedValue({ ...fullResultsPage(), task_id: "task-b" });
    api.export.list.mockResolvedValue({ task_id: "task-b", items: [], limit: 10, offset: 0 });
    api.export.listJobs.mockResolvedValue({ task_id: "task-b", items: [], limit: 50, offset: 0, total: 0 });
    await act(async () => { navigate("/export/task-b"); });

    // 关键断言：B 页面的导出按钮可用（busy 已重置为 false）
    await waitFor(() => {
      const startButton = screen.queryByRole("button", { name: /开始导出/ });
      return startButton && !startButton.hasAttribute("disabled");
    }, { timeout: 5000 });
    const startButton = screen.getByRole("button", { name: /开始导出/ });
    expect(startButton.hasAttribute("disabled")).toBe(false);

    // 释放 cancel deferred（避免 pending promise 残留）
    cancelReq.resolve({ export_id: "exp-a", status: "cancelling" });
    await flushMicrotasks();
    expect(cancelReq.settled).toBe(true);
  });
});
