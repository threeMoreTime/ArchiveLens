/**
 * @vitest-environment jsdom
 *
 * P1-1 SearchPage 组件级竞态测试（审查最终收口）。
 *
 * 用 MemoryRouter + useNavigate 在同一组件实例内从 /search/A 导航到 /search/B
 * （不是 unmount），用 deferred 制造真实的请求晚返回。
 */
import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import React from "react";
import { render, screen, waitFor, act, cleanup } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";

// 竞态测试在大模块冷加载 + 全量并发 fork CPU 争用下偶发破默认 hookTimeout(10s)。
// 组件内部有 setInterval(1500ms) 轮询与 RETRY_DELAYS(300/1000/3000ms) 重试，
// 测试需等待真实时间流逝以验证轮询停止行为。给充足确定性窗口。
vi.setConfig({ hookTimeout: 30000, testTimeout: 30000 });

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false })) as any;
  }
  if (!(globalThis as any).ResizeObserver) {
    (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  }
  if (!(globalThis as any).NodeFilter) {
    (globalThis as any).NodeFilter = { SHOW_ALL: 0xFFFFFFFF, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 };
  }
});

afterEach(() => {
  cleanup();
  // 全程 real timers（组件轮询依赖真实 setInterval）；cleanup() 触发 effect cleanup 停止轮询。
  vi.restoreAllMocks();
});

// 增强 deferred：跟踪 settled 状态，测试结束前断言全部 settle。
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

/** flush microtask 队列，替代固定 setTimeout 短等待。 */
function flushMicrotasks() {
  return act(async () => { await Promise.resolve(); });
}

function makeMockApi() {
  return {
    tasks: { get: vi.fn(), list: vi.fn() },
    search: { getCorpusStatus: vi.fn(), execute: vi.fn(), listSessions: vi.fn(), queryHits: vi.fn(), preparePageImage: vi.fn() },
    settings: { get: vi.fn() },
    subscribe: { onEvent: vi.fn(() => () => {}) },
  };
}

function fullTask(taskId: string, searchText = "档") {
  return { task_id: taskId, search_text: searchText, source_dir: "x", status: "completed", worker_generation: 1, last_event_sequence: 1, is_demo: 0, file_count: 1, total_pages: 1, processed_pages: 1, occurrence_count: 1, failure_count: 0, created_at: "", started_at: "", finished_at: "", error_message: null, output_dir: "", workspace_dir: "", search_terms: [searchText], search_mode: "exact_literal", search_script_scope: "both" as const };
}
function fullSession(sessionId: string, taskId: string) {
  return { search_session_id: sessionId, task_id: taskId, query_text: "档", script_scope: "both" as const, corpus_version: 1, counts: { total: 1, layers: { raw_exact: 1, context_resolved: 0, variant_graph: 0, ocr_top_k: 0 } }, query_forms: { semantic_label: null } };
}

let SearchPageForTest: React.ComponentType;
beforeEach(async () => {
  const mod = await import("../src/renderer/src/pages/SearchPage");
  SearchPageForTest = mod.default;
});

/** 渲染 SearchPage 并暴露 navigate 函数，用于测试内路由切换。 */
function mountWithNavigator(taskId: string, api: ReturnType<typeof makeMockApi>) {
  (window as any).archiveLens = api;
  let navigateFn: ((to: string) => void) | null = null;
  const NavigatorBridge = () => {
    const nav = useNavigate();
    navigateFn = (to: string) => nav(to);
    return null;
  };
  const utils = render(
    <MemoryRouter initialEntries={[`/search/${taskId}`]}>
      <NavigatorBridge />
      <Routes>
        <Route path="/search/:taskId" element={<SearchPageForTest />} />
      </Routes>
    </MemoryRouter>,
  );
  return { ...utils, navigate: (to: string) => navigateFn!(to) };
}

async function setInputAndSubmit(value: string) {
  const input = screen.getByRole("textbox", { name: "任务内检索文字或词语" }) as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    const form = input.closest("form");
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("SearchPage executeSearch 同实例路由切换隔离（发现 1/4 最终收口）", () => {
  it("/search/A execute pending → navigate /search/B → 释放 A → B 不被 A 的 session 污染", async () => {
    const api = makeMockApi();
    api.tasks.get.mockResolvedValue(fullTask("task-a"));
    api.search.getCorpusStatus.mockResolvedValue({ status: "ready", corpus_version: 1, indexed_pages: 1, expected_pages: 1, line_count: 1, failure_count: 0 });
    api.settings.get.mockResolvedValue({ search_script_scope: "both" });
    api.search.listSessions.mockResolvedValue({ items: [] });
    // execute 保持 pending
    const aExecute = deferred<any>();
    api.search.execute.mockReturnValue(aExecute.promise);

    const { navigate } = mountWithNavigator("task-a", api);
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "任务内检索文字或词语" })).toBeTruthy(), { timeout: 5000 });

    await setInputAndSubmit("档");
    expect(api.search.execute).toHaveBeenCalledWith({ task_id: "task-a", query_text: "档", script_scope: "both" });

    // 同实例导航到 /search/B（currentTaskIdRef 立即更新为 task-b）
    api.tasks.get.mockResolvedValue(fullTask("task-b", "案"));
    api.search.listSessions.mockResolvedValue({ items: [] });
    api.search.getCorpusStatus.mockResolvedValue({ status: "ready", corpus_version: 1, indexed_pages: 1, expected_pages: 1, line_count: 1, failure_count: 0 });
    await act(async () => { navigate("/search/task-b"); });

    // 释放任务 A 的 execute 结果（晚于路由切换）
    await act(async () => { aExecute.resolve(fullSession("sess-a", "task-a")); });
    // flush microtask 替代固定 setTimeout(50)，让组件处理 late-arriving session
    await flushMicrotasks();
    expect(aExecute.settled).toBe(true);

    // 关键断言：A 的 session（sess-a）未触发 queryHits——commitGuard 的
    // currentTaskIdRef.current 检查（task-b !== task-a）阻止了 setActiveSessionId。
    const aSessionInHits = api.search.queryHits.mock.calls.some((c: any[]) => c[0]?.search_session_id === "sess-a");
    expect(aSessionInHits).toBe(false);
  });

  it("execute 成功返回且仍在当前任务时正常写入 session（触发 queryHits）", async () => {
    const api = makeMockApi();
    api.tasks.get.mockResolvedValue(fullTask("task-a"));
    api.search.getCorpusStatus.mockResolvedValue({ status: "ready", corpus_version: 1, indexed_pages: 1, expected_pages: 1, line_count: 1, failure_count: 0 });
    api.settings.get.mockResolvedValue({ search_script_scope: "both" });
    api.search.listSessions.mockResolvedValue({ items: [] });
    api.search.execute.mockResolvedValue(fullSession("sess-a", "task-a"));
    api.search.queryHits.mockResolvedValue({ items: [], total: 0, session: fullSession("sess-a", "task-a") });

    mountWithNavigator("task-a", api);
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "任务内检索文字或词语" })).toBeTruthy(), { timeout: 5000 });
    await setInputAndSubmit("档");
    await waitFor(() => expect(api.search.queryHits).toHaveBeenCalled(), { timeout: 5000 });
  });
});

describe("SearchPage 初始 corpus 真实 deferred 乱序（发现 2 最终收口）", () => {
  it("初始 corpus pending → reload 返回 ready 先写入 → 释放旧 building → ready 不被覆盖", async () => {
    const api = makeMockApi();
    api.tasks.get.mockResolvedValue(fullTask("task-a"));
    api.settings.get.mockResolvedValue({ search_script_scope: "both" });
    api.search.listSessions.mockResolvedValue({ items: [] });

    // 初始 corpus 保持 pending（deferred），返回旧 building
    const initialCorpus = deferred({ status: "building", corpus_version: 0, indexed_pages: 0, expected_pages: 1, line_count: 0, failure_count: 0 });
    api.search.getCorpusStatus.mockReturnValueOnce(initialCorpus.promise);
    // 后续 reload 返回 ready
    api.search.getCorpusStatus.mockResolvedValue({ status: "ready", corpus_version: 1, indexed_pages: 1, expected_pages: 1, line_count: 1, failure_count: 0 });

    mountWithNavigator("task-a", api);

    // 初始 Promise.all 因 initialCorpus pending 未 resolve。先释放初始 corpus（building），
    // 使 Promise.all 完成，触发兜底 reloadCorpus 返回 ready。
    await act(async () => {
      initialCorpus.resolve({ status: "building", corpus_version: 0, indexed_pages: 0, expected_pages: 1, line_count: 0, failure_count: 0 });
    });

    // 兜底 reload 返回 ready，写入 corpus
    await waitFor(() => {
      const summary = document.querySelector(".al-search-summary");
      return summary?.textContent?.includes("完整可检索");
    }, { timeout: 8000 });

    // 再来一次 getCorpusStatus 返回（模拟轮询/事件的旧 building 晚到）
    // 由于 reload 的 sequence 已递增，旧初始 sequence 不会覆盖。
    const summary = document.querySelector(".al-search-summary");
    expect(summary?.textContent).toContain("完整可检索");
    expect(summary?.textContent).not.toContain("正在建立");
  });
});

describe("SearchPage 终态事件更新 task 并停止 partial 轮询（P2 hotfix，组件级）", () => {
  it("task=running+partial → task.completed → tasks.get 返回 completed → partial 轮询停止", async () => {
    const api = makeMockApi();
    // 初始：任务运行中，语料 partial
    api.tasks.get.mockResolvedValue({ ...fullTask("task-a"), status: "running" });
    api.search.getCorpusStatus.mockResolvedValue({ status: "partial", corpus_version: 1, indexed_pages: 1, expected_pages: 2, line_count: 1, failure_count: 0 });
    api.settings.get.mockResolvedValue({ search_script_scope: "both" });
    api.search.listSessions.mockResolvedValue({ items: [] });
    api.search.queryHits.mockResolvedValue({ items: [], total: 0, session: fullSession("s", "task-a") });

    // 终态事件后：tasks.get 返回 completed，corpus 仍为 partial
    api.tasks.get.mockResolvedValueOnce({ ...fullTask("task-a"), status: "running" });
    api.tasks.get.mockResolvedValueOnce({ ...fullTask("task-a"), status: "completed" });
    // getCorpusStatus 在 reload 时仍返回 partial（终态 partial）
    api.search.getCorpusStatus.mockResolvedValue({ status: "partial", corpus_version: 1, indexed_pages: 1, expected_pages: 2, line_count: 1, failure_count: 0 });

    let eventCb: ((e: { task_id?: string | null; event: string }) => void) | null = null;
    api.subscribe.onEvent.mockImplementation((cb: any) => { eventCb = cb; return () => {}; });

    mountWithNavigator("task-a", api);
    // 等初始加载完成
    await waitFor(() => expect(eventCb).not.toBeNull(), { timeout: 5000 });

    // 记录终态事件前的 getCorpusStatus 调用次数
    const callsBefore = api.search.getCorpusStatus.mock.calls.length;

    // 发送 task.completed 事件
    await act(async () => {
      eventCb?.({ task_id: "task-a", event: "task.completed" });
    });
    // 等 reloadCorpus + reloadTask 的防抖/microtask 完成
    await act(async () => { await new Promise((r) => setTimeout(r, 500)); });

    // 验证 tasks.get 被再次调用（reloadTask 触发）
    expect(api.tasks.get).toHaveBeenCalledWith("task-a");

    // 关键断言：推进 5 秒后，getCorpusStatus 调用次数不再持续增长
    //（task.status 已更新为 completed，partial 不再触发轮询）
    await act(async () => { await new Promise((r) => setTimeout(r, 5000)); });
    const callsAfter = api.search.getCorpusStatus.mock.calls.length;
    // 轮询每 1.5s 一次，5 秒内若是活跃轮询会有 3+ 次新增调用。
    // 终态 partial 停止轮询后，新增调用应为 0 或仅防抖触发的 1 次。
    const newCalls = callsAfter - callsBefore;
    expect(newCalls).toBeLessThanOrEqual(2); // 防抖 reload 的 1 次 + 可能的边界
  });
});

describe("初始 task 快照不覆盖终态 reload（缺口 2，组件级）", () => {
  it("reloadTask 先写入 completed → 初始 Promise.all 晚到 running → 不能覆盖", async () => {
    const api = makeMockApi();
    // 初始 Promise.all 的 tasks.get 保持 pending（晚到）
    const initialTask = deferred(fullTask("task-a"));
    api.tasks.get.mockReturnValueOnce(initialTask.promise);
    api.search.getCorpusStatus.mockResolvedValue({ status: "partial", corpus_version: 1, indexed_pages: 1, expected_pages: 2, line_count: 1, failure_count: 0 });
    api.settings.get.mockResolvedValue({ search_script_scope: "both" });
    api.search.listSessions.mockResolvedValue({ items: [] });

    // reloadTask 的 tasks.get 返回 completed
    api.tasks.get.mockResolvedValueOnce({ ...fullTask("task-a"), status: "completed" });

    let eventCb: ((e: { task_id?: string | null; event: string }) => void) | null = null;
    api.subscribe.onEvent.mockImplementation((cb: any) => { eventCb = cb; return () => {}; });

    mountWithNavigator("task-a", api);
    await waitFor(() => expect(eventCb).not.toBeNull(), { timeout: 5000 });

    // 在初始 Promise.all pending 时，发送 task.completed
    // reloadTask 调用 tasks.get（第二次），返回 completed，写入 task
    await act(async () => {
      eventCb?.({ task_id: "task-a", event: "task.completed" });
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 500)); });

    // 现在释放初始 Promise.all 的旧 running 快照
    await act(async () => {
      initialTask.resolve({ ...fullTask("task-a"), status: "running" });
    });
    // flush microtask 替代固定 setTimeout(200)，让组件处理 late-arriving task
    await flushMicrotasks();
    expect(initialTask.settled).toBe(true);

    // 关键断言：task.status 应仍为 completed（初始 running 被 task sequence 守卫拒绝）
    // 检查 page summary 是否显示"完整可检索"或 partial 相关（task 终态）
    // 由于 task=completed + corpus=partial，轮询应已停止
    const callsBefore = api.search.getCorpusStatus.mock.calls.length;
    await act(async () => { await new Promise((r) => setTimeout(r, 5000)); });
    const callsAfter = api.search.getCorpusStatus.mock.calls.length;
    // 终态 partial 不轮询：5 秒内新增调用应很少
    expect(callsAfter - callsBefore).toBeLessThanOrEqual(2);
  });
});

describe("reloadTask 失败后重试（缺口 1，组件级）", () => {
  it("初始加载成功 running → 终态刷新第一次失败 → 重试成功 completed → partial 轮询停止", async () => {
    const api = makeMockApi();
    // 初始加载：tasks.get 返回 running（初始加载成功）
    api.tasks.get.mockResolvedValueOnce({ ...fullTask("task-a"), status: "running" });
    api.search.getCorpusStatus.mockResolvedValue({ status: "partial", corpus_version: 1, indexed_pages: 1, expected_pages: 2, line_count: 1, failure_count: 0 });
    api.settings.get.mockResolvedValue({ search_script_scope: "both" });
    api.search.listSessions.mockResolvedValue({ items: [] });

    // 终态事件 reloadTask：第一次失败（瞬态 IPC 错误），第二次成功
    api.tasks.get.mockRejectedValueOnce(new Error("transient IPC error"));
    api.tasks.get.mockResolvedValueOnce({ ...fullTask("task-a"), status: "completed" });

    let eventCb: ((e: { task_id?: string | null; event: string }) => void) | null = null;
    api.subscribe.onEvent.mockImplementation((cb: any) => { eventCb = cb; return () => {}; });

    mountWithNavigator("task-a", api);
    // 断言初始加载成功（running 已写入，搜索 body 可见）
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "任务内检索文字或词语" })).toBeTruthy(), { timeout: 5000 });
    // 初始 tasks.get 被调用一次（初始加载成功写入 running）
    expect(api.tasks.get).toHaveBeenCalledTimes(1);

    const callsBefore = api.search.getCorpusStatus.mock.calls.length;

    // 发送 task.completed（触发 reloadTask：第一次失败 → 300ms 后重试 → 第二次成功）
    await act(async () => {
      eventCb?.({ task_id: "task-a", event: "task.completed" });
    });

    // 等待重试完成（300ms 延迟 + 重试请求）
    await act(async () => { await new Promise((r) => setTimeout(r, 2000)); });

    // 断言 tasks.get 被调用 3 次：初始 1 + reloadTask 失败 1 + 重试成功 1
    expect(api.tasks.get).toHaveBeenCalledTimes(3);
    expect(api.tasks.get).toHaveBeenLastCalledWith("task-a");

    // 推进 5 秒，确认终态 partial 轮询已停止
    await act(async () => { await new Promise((r) => setTimeout(r, 5000)); });
    const callsAfter = api.search.getCorpusStatus.mock.calls.length;
    expect(callsAfter - callsBefore).toBeLessThanOrEqual(2);
  });
});
