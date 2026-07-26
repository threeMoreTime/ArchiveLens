/**
 * @vitest-environment jsdom
 *
 * P1-1 SearchPage 组件级竞态测试（发现 1/2/4 的真实组件验证）。
 *
 * 渲染真实 SearchPage，用 deferred（pending Promise）精确制造请求乱序。
 * 不用 fake timers（vitest worker 池下 fake timers + jsdom 不稳定）；
 * 通过让初始 corpus 返回 ready 避免触发轮询 setInterval，使测试只依赖
 * deferred 控制的请求时序。
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
    tasks: { get: vi.fn(), list: vi.fn() },
    search: {
      getCorpusStatus: vi.fn(),
      execute: vi.fn(),
      listSessions: vi.fn(),
      queryHits: vi.fn(),
      preparePageImage: vi.fn(),
    },
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

function mountSearchPage(taskId: string, api: ReturnType<typeof makeMockApi>) {
  (window as any).archiveLens = api;
  return render(
    <MemoryRouter initialEntries={[`/search/${taskId}`]}>
      <Routes>
        <Route path="/search/:taskId" element={<SearchPageForTest />} />
      </Routes>
    </MemoryRouter>,
  );
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

describe("SearchPage executeSearch 跨任务隔离（发现 1/4，真实 deferred 乱序）", () => {
  it("任务 A execute pending → 卸载（切任务模拟）→ 释放 A → 不在卸载后写入（无 queryHits for sess-a）", async () => {
    const api = makeMockApi();
    api.tasks.get.mockResolvedValue(fullTask("task-a"));
    api.search.getCorpusStatus.mockResolvedValue({ status: "ready", corpus_version: 1, indexed_pages: 1, expected_pages: 1, line_count: 1, failure_count: 0 });
    api.settings.get.mockResolvedValue({ search_script_scope: "both" });
    api.search.listSessions.mockResolvedValue({ items: [] });
    // execute 保持 pending（可控 deferred）
    const aExecute = deferred<any>();
    api.search.execute.mockReturnValue(aExecute.promise);

    const { unmount } = mountSearchPage("task-a", api);
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "任务内检索文字或词语" })).toBeTruthy(), { timeout: 5000 });

    await setInputAndSubmit("档");
    expect(api.search.execute).toHaveBeenCalledWith({ task_id: "task-a", query_text: "档", script_scope: "both" });

    // 卸载（模拟离开页面/切任务）——searchMountedRef=false，searchRouteGeneration 此时不变
    // 但 mounted=false 足以让 commitGuard 拒绝写入。
    unmount();

    // 释放任务 A 的 execute 结果（晚于卸载）
    await act(async () => { aExecute.resolve(fullSession("sess-a", "task-a")); });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    // 关键断言：A 的 session（sess-a）未触发 queryHits——commitGuard 阻止了
    // setActiveSessionId(sess-a)，所以 queryHits 不会被 sess-a 调用。
    const queryHitsCalls = api.search.queryHits.mock.calls;
    const aSessionInHits = queryHitsCalls.some((c: any[]) => c[0]?.search_session_id === "sess-a");
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

    mountSearchPage("task-a", api);
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "任务内检索文字或词语" })).toBeTruthy(), { timeout: 5000 });
    await setInputAndSubmit("档");

    // 成功写入：activeSessionId 变化触发 queryHits
    await waitFor(() => expect(api.search.queryHits).toHaveBeenCalled(), { timeout: 5000 });
  });
});

describe("SearchPage 初始 corpus sequence 守卫（发现 2，真实 deferred 乱序）", () => {
  it("初始 corpus 立即返回 building → 兜底 reload 返回 ready → ready 写入（sequence 守卫不误杀）", async () => {
    const api = makeMockApi();
    api.tasks.get.mockResolvedValue(fullTask("task-a"));
    api.settings.get.mockResolvedValue({ search_script_scope: "both" });
    api.search.listSessions.mockResolvedValue({ items: [] });
    api.search.getCorpusStatus.mockResolvedValueOnce({ status: "building", corpus_version: 0, indexed_pages: 0, expected_pages: 1, line_count: 0, failure_count: 0 });
    api.search.getCorpusStatus.mockResolvedValueOnce({ status: "ready", corpus_version: 1, indexed_pages: 1, expected_pages: 1, line_count: 1, failure_count: 0 });

    mountSearchPage("task-a", api);

    // 兜底 reload（初始 building 后）返回 ready，写入 corpus
    await waitFor(() => {
      const summary = document.querySelector(".al-search-summary");
      return summary?.textContent?.includes("完整可检索");
    }, { timeout: 8000 });

    expect(api.search.getCorpusStatus).toHaveBeenCalledTimes(2);
    const summary = document.querySelector(".al-search-summary");
    expect(summary?.textContent).toContain("完整可检索");
  });
});
