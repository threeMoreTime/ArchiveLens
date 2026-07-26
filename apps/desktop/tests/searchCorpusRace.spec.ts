import { describe, expect, it, vi } from "vitest";
import { shouldCommit } from "../src/renderer/src/utils/requestGuard";

/**
 * P1-1 SearchPage 语料事件刷新与请求隔离的确定性行为测试。
 *
 * 复刻 SearchPage 的 corpus 事件订阅 + 防抖 + 身份守卫逻辑，用可控事件回调、
 * fake timer 与 deferred 验证真实行为（非源码字符串断言）。
 *
 * Engine 真实事件名（已核实）：task.completed/failed/cancelled/resumed/
 * occurrences_reconciled。扫描过程无高频 progress 事件。
 */

const CORPUS_REFRESH_EVENTS = [
  "task.completed", "task.failed", "task.cancelled",
  "task.resumed", "task.occurrences_reconciled",
];
const DEBOUNCE_MS = 300;

/** 复刻 SearchPage 的 corpus 协调器：事件订阅 + 防抖 + 身份守卫写入。 */
function makeCorpusCoordinator() {
  let currentTaskId = "task-a";
  let currentGeneration = 1;
  let currentSequence = 0;
  let mounted = true;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const refreshCalls: string[] = [];
  const committedCorpus: { status: string; task: string }[] = [];
  let corpusImpl: (id: string) => Promise<{ status: string }>;

  const ctx = () => ({ currentTaskId, currentGeneration, currentSequence, mounted });

  async function reloadCorpus(id: string, generation: number) {
    const seq = ++currentSequence;
    const result = await corpusImpl(id);
    if (!shouldCommit({ taskId: id, generation, sequence: seq }, ctx())) return;
    committedCorpus.push({ status: result.status, task: id });
  }

  function refreshCorpus() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      refreshCalls.push(currentTaskId);
      void reloadCorpus(currentTaskId, currentGeneration);
    }, DEBOUNCE_MS);
  }

  return {
    setCorpusImpl(impl: (id: string) => Promise<{ status: string }>) { corpusImpl = impl; },
    /** 事件回调：复刻 SearchPage subscribe.onEvent 的过滤逻辑。 */
    onEvent(event: { task_id?: string | null; event: string }) {
      if (event.task_id !== currentTaskId) return;
      if (CORPUS_REFRESH_EVENTS.includes(event.event)) refreshCorpus();
    },
    switchTask(newId: string) {
      currentTaskId = newId;
      currentGeneration += 1;
      currentSequence += 1;
      committedCorpus.length = 0;
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    },
    unmount() {
      mounted = false;
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    },
    getRefreshCalls: () => refreshCalls,
    getCommitted: () => committedCorpus,
    flushDebounce: () => { if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; } },
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("P1-1 corpus 事件刷新", () => {
  it("当前任务 completed 事件触发防抖刷新，corpus 更新为 ready", async () => {
    vi.useFakeTimers();
    const coord = makeCorpusCoordinator();
    coord.setCorpusImpl(async () => ({ status: "ready" }));
    // 任务完成事件
    coord.onEvent({ task_id: "task-a", event: "task.completed" });
    expect(coord.getRefreshCalls()).toEqual([]); // 防抖未到，尚未刷新
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await Promise.resolve(); // 让 microtask 完成
    expect(coord.getRefreshCalls()).toEqual(["task-a"]);
    expect(coord.getCommitted()).toEqual([{ status: "ready", task: "task-a" }]);
    vi.useRealTimers();
  });

  it("其他 taskId 的事件被立即忽略，不触发刷新", async () => {
    vi.useFakeTimers();
    const coord = makeCorpusCoordinator();
    coord.setCorpusImpl(async () => ({ status: "ready" }));
    // 任务 B 的事件（当前页面是 A）
    coord.onEvent({ task_id: "task-b", event: "task.completed" });
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await Promise.resolve();
    expect(coord.getRefreshCalls()).toEqual([]);
    expect(coord.getCommitted()).toEqual([]);
    vi.useRealTimers();
  });

  it("无关事件名（如 task.created）不触发 corpus 刷新", async () => {
    vi.useFakeTimers();
    const coord = makeCorpusCoordinator();
    coord.setCorpusImpl(async () => ({ status: "ready" }));
    coord.onEvent({ task_id: "task-a", event: "task.created" });
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await Promise.resolve();
    expect(coord.getRefreshCalls()).toEqual([]);
    vi.useRealTimers();
  });

  it("高频连续事件被防抖合并为一次刷新", async () => {
    vi.useFakeTimers();
    const coord = makeCorpusCoordinator();
    coord.setCorpusImpl(async () => ({ status: "ready" }));
    // 模拟连续 5 个事件（防御未来可能的进度事件）
    for (let i = 0; i < 5; i += 1) {
      coord.onEvent({ task_id: "task-a", event: "task.occurrences_reconciled" });
      vi.advanceTimersByTime(100); // 每次都在防抖窗口内
    }
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await Promise.resolve();
    expect(coord.getRefreshCalls()).toEqual(["task-a"]); // 只刷新一次
    vi.useRealTimers();
  });

  it("卸载后 pending 防抖定时器被清除，不刷新不写入", async () => {
    vi.useFakeTimers();
    const coord = makeCorpusCoordinator();
    coord.setCorpusImpl(async () => ({ status: "ready" }));
    coord.onEvent({ task_id: "task-a", event: "task.completed" });
    coord.unmount(); // 卸载应清除定时器
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await Promise.resolve();
    expect(coord.getRefreshCalls()).toEqual([]);
    expect(coord.getCommitted()).toEqual([]);
    vi.useRealTimers();
  });
});

describe("P1-1 corpus 请求隔离（跨任务竞态）", () => {
  it("任务 A 的 corpusStatus 晚于任务 B 返回，不覆盖 B", async () => {
    vi.useFakeTimers();
    const coord = makeCorpusCoordinator();
    // 任务 A 的 corpusStatus 先发出但保持 pending
    const aReq = deferred<{ status: string }>();
    let callCount = 0;
    coord.setCorpusImpl((id) => {
      callCount += 1;
      return id === "task-a" ? aReq.promise : Promise.resolve({ status: "ready" });
    });
    // 触发 A 的刷新（防抖后发出 A 请求）
    coord.onEvent({ task_id: "task-a", event: "task.completed" });
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await Promise.resolve();
    expect(callCount).toBe(1); // A 请求已发出，pending

    // 切换到任务 B
    coord.switchTask("task-b");
    // B 的 corpusStatus 立即返回 ready
    coord.onEvent({ task_id: "task-b", event: "task.completed" });
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await Promise.resolve();
    // 释放 A 的请求（晚于 B 返回）
    aReq.resolve({ status: "ready" });
    await Promise.resolve();

    // 关键断言：committed 只有 B（A 的结果被身份守卫丢弃，未覆盖 B）
    const committed = coord.getCommitted();
    expect(committed.every((c) => c.task === "task-b")).toBe(true);
    expect(committed.some((c) => c.task === "task-a")).toBe(false);
    vi.useRealTimers();
  });

  it("卸载后 pending 请求 resolve 不写入 corpus", async () => {
    vi.useFakeTimers();
    const coord = makeCorpusCoordinator();
    const req = deferred<{ status: string }>();
    coord.setCorpusImpl(() => req.promise);
    coord.onEvent({ task_id: "task-a", event: "task.completed" });
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await Promise.resolve();
    coord.unmount();
    req.resolve({ status: "ready" });
    await Promise.resolve();
    expect(coord.getCommitted()).toEqual([]);
    vi.useRealTimers();
  });
});
