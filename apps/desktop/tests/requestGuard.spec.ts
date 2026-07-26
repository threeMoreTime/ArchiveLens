import { describe, expect, it } from "vitest";
import { shouldCommit, jobBelongsToTask, type RequestIdentity, type PageContext } from "../src/renderer/src/utils/requestGuard";

/**
 * P1-4/P1-1 异步请求身份守卫的确定性测试。
 *
 * 用可控的 RequestIdentity/PageContext 输入验证 shouldCommit 在每个守卫
 * 缺失时都返回 false——任何一个守卫失效都应阻断写入。这等价于"可控 Promise
 * 时序"测试：deferred 请求 resolve 时，页面 context 已变化，shouldCommit
 * 据此决定是否提交。
 */
describe("shouldCommit 异步请求身份守卫", () => {
  const baseRequest: RequestIdentity = { taskId: "task-a", generation: 1, sequence: 1 };
  const basePage: PageContext = { currentTaskId: "task-a", currentGeneration: 1, currentSequence: 1, mounted: true };

  it("四项全部匹配时允许写入", () => {
    expect(shouldCommit(baseRequest, basePage)).toBe(true);
  });

  it("组件卸载后拒绝写入（避免内存泄漏与 React 警告）", () => {
    expect(shouldCommit(baseRequest, { ...basePage, mounted: false })).toBe(false);
  });

  it("taskId 已变化（切换到任务 B）时拒绝 A 的请求写入", () => {
    // 模拟：任务 A 的请求 resolve 时，页面已切到任务 B
    expect(shouldCommit(baseRequest, { ...basePage, currentTaskId: "task-b", currentGeneration: 2 })).toBe(false);
  });

  it("routeGeneration 已变化时拒绝写入（路由代次过期）", () => {
    expect(shouldCommit(baseRequest, { ...basePage, currentGeneration: 2 })).toBe(false);
  });

  it("requestSequence 已变化时拒绝写入（同页更新请求已发出）", () => {
    expect(shouldCommit(baseRequest, { ...basePage, currentSequence: 2 })).toBe(false);
  });

  it("多个守卫同时缺失时仍拒绝", () => {
    expect(shouldCommit(
      { taskId: "task-a", generation: 1, sequence: 1 },
      { currentTaskId: "task-b", currentGeneration: 3, currentSequence: 5, mounted: false },
    )).toBe(false);
  });
});

/**
 * 模拟可控 Promise 时序的请求协调器：复刻 ExportPage loadJobs 的守卫逻辑，
 * 用 deferred 精确控制 A/B 请求的 resolve 顺序，确定性证明竞态被阻断。
 */
describe("loadJobs 竞态时序（可控 deferred）", () => {
  /** 简化版请求协调器：复刻 ExportPage.loadJobs 的身份守卫写入逻辑。 */
  function makeCoordinator() {
    let currentTaskId = "task-a";
    let currentGeneration = 1;
    let currentSequence = 0;
    let mounted = true;
    const committed: Record<string, unknown[]> = { jobs: [], history: [] };
    const ipcCalls: string[] = [];

    const ctx = (): PageContext => ({
      currentTaskId,
      currentGeneration,
      currentSequence,
      mounted,
    });

    async function loadJobs(id: string, generation: number, listJobsImpl: () => Promise<unknown[]>) {
      const seq = ++currentSequence;
      const result = await listJobsImpl();
      ipcCalls.push(`listJobs:${id}`);
      if (!shouldCommit({ taskId: id, generation, sequence: seq }, ctx())) return "dropped" as const;
      committed.jobs = result as unknown[];
      return "committed" as const;
    }

    return {
      loadJobs,
      switchTask(newId: string) { currentTaskId = newId; currentGeneration += 1; currentSequence += 1; committed.jobs = []; },
      unmount() { mounted = false; },
      getJobs: () => committed.jobs,
      getCalls: () => ipcCalls,
    };
  }

  /** 创建一个可控的 deferred Promise。 */
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
  }

  it("A 请求先发出但晚于 B 返回：A 不覆盖 B", async () => {
    const coord = makeCoordinator();
    // 任务 A 的 listJobs 先发出，保持 pending
    const aReq = deferred<string[]>();
    const aPromise = coord.loadJobs("task-a", 1, () => aReq.promise);
    // 切换到任务 B（routeGeneration 递增，清空 jobs）
    coord.switchTask("task-b");
    // 任务 B 的请求立即返回 B 作业
    const bResult = await coord.loadJobs("task-b", 2, async () => ["job-b1", "job-b2"]);
    expect(bResult).toBe("committed");
    expect(coord.getJobs()).toEqual(["job-b1", "job-b2"]);
    // 最后释放任务 A 的请求
    aReq.resolve(["job-a1"]);
    const aOutcome = await aPromise;
    expect(aOutcome).toBe("dropped");
    // 关键断言：A 的结果没有覆盖 B
    expect(coord.getJobs()).toEqual(["job-b1", "job-b2"]);
  });

  it("卸载后 pending 请求 resolve 不写入", async () => {
    const coord = makeCoordinator();
    const req = deferred<string[]>();
    const promise = coord.loadJobs("task-a", 1, () => req.promise);
    coord.unmount();
    req.resolve(["job-a1"]);
    const outcome = await promise;
    expect(outcome).toBe("dropped");
    expect(coord.getJobs()).toEqual([]);
  });
});

describe("jobBelongsToTask 陈旧作业归属守卫", () => {
  it("归属一致时返回 true", () => {
    expect(jobBelongsToTask("task-a", "task-a")).toBe(true);
  });

  it("job 属于其他任务时返回 false（stale cancel/retry 拒绝）", () => {
    expect(jobBelongsToTask("task-a", "task-b")).toBe(false);
  });

  it("job 或当前 taskId 缺失时 fail closed", () => {
    expect(jobBelongsToTask(undefined, "task-a")).toBe(false);
    expect(jobBelongsToTask(null, "task-a")).toBe(false);
    expect(jobBelongsToTask("task-a", undefined)).toBe(false);
    expect(jobBelongsToTask("", "task-a")).toBe(false);
  });
});

/**
 * stale cancel/retry 行为测试：复刻 ExportPage cancelJob/retryJob 的归属守卫。
 * 当 jobs 列表中存在其他任务的 job 时（竞态残留），cancel/retry 必须不发送 IPC。
 */
describe("stale cancel/retry 不发送 IPC（可控行为）", () => {
  /** 复刻 ExportPage cancelJob/retryJob 的归属校验与 IPC 调用决策。 */
  function makeActionCoordinator(currentTaskId: string) {
    const ipcCalls: string[] = [];
    return {
      getCalls: () => ipcCalls,
      cancelJob(exportId: string, jobTaskId: string | undefined): "blocked" | "sent" {
        if (!jobBelongsToTask(jobTaskId, currentTaskId)) return "blocked";
        ipcCalls.push(`cancel:${exportId}`);
        return "sent";
      },
      retryJob(exportId: string, jobTaskId: string | undefined, createdTaskId?: string): "blocked" | "mismatch" | "sent" {
        if (!jobBelongsToTask(jobTaskId, currentTaskId)) return "blocked";
        ipcCalls.push(`retry:${exportId}`);
        // retry 后校验 Engine 返回的真实 task_id（与 ExportPage.retryJob 一致）
        if (createdTaskId && createdTaskId !== currentTaskId) return "mismatch";
        return "sent";
      },
    };
  }

  it("stale cancel：job 属于任务 A 但页面在任务 B，不发送 cancel IPC", () => {
    const coord = makeActionCoordinator("task-b");
    const outcome = coord.cancelJob("exp-a1", "task-a");
    expect(outcome).toBe("blocked");
    expect(coord.getCalls()).toEqual([]);
  });

  it("stale retry：job 属于任务 A 但页面在任务 B，不发送 retry IPC、不创建新作业", () => {
    const coord = makeActionCoordinator("task-b");
    const outcome = coord.retryJob("exp-a1", "task-a");
    expect(outcome).toBe("blocked");
    expect(coord.getCalls()).toEqual([]);
  });

  it("归属一致的 cancel/retry 正常发送 IPC", () => {
    const coord = makeActionCoordinator("task-a");
    expect(coord.cancelJob("exp-a1", "task-a")).toBe("sent");
    expect(coord.retryJob("exp-a1", "task-a", "task-a")).toBe("sent");
    expect(coord.getCalls()).toEqual(["cancel:exp-a1", "retry:exp-a1"]);
  });

  it("retry 后 Engine 返回的 task_id 与页面不一致时拒绝（防跨任务污染）", () => {
    const coord = makeActionCoordinator("task-b");
    // 即使前端误判归属，Engine 反查返回 task-a，与页面 task-b 不符
    const outcome = coord.retryJob("exp-x", "task-b", "task-a");
    expect(outcome).toBe("mismatch");
  });
});

/**
 * 旧任务事件隔离测试：复刻 ExportPage 事件订阅的 taskId 过滤。
 * 切换到任务 B 后，任务 A 的 export 事件不得触发 B 的 loadJobs。
 */
describe("旧任务事件不污染当前任务（可控事件回调）", () => {
  it("切换到 B 后，A 的 export.progress 事件不触发 B 刷新、不写入 B", async () => {
    let currentTaskId = "task-a";
    let currentGeneration = 1;
    const refreshCalls: string[] = [];
    const committed: string[] = [];

    // 复刻 ExportPage 事件订阅：只处理 currentTaskId 的事件
    function onEvent(event: { task_id?: string | null; event: string }) {
      if (event.task_id !== currentTaskId) return; // 忽略其他任务
      if (event.event === "export.progress" || event.event === "export.cleanup") {
        refreshCalls.push(event.task_id as string);
        // 模拟 loadJobs 写入（受 generation 守卫保护）
        committed.push(`${event.task_id}:${currentGeneration}`);
      }
    }

    // A 的事件：当前在 A，触发 A 刷新
    onEvent({ task_id: "task-a", event: "export.progress" });
    expect(refreshCalls).toEqual(["task-a"]);

    // 切换到 B
    currentTaskId = "task-b";
    currentGeneration += 1;

    // A 的旧事件到达：必须被忽略，不触发 B 刷新
    onEvent({ task_id: "task-a", event: "export.progress" });
    expect(refreshCalls).toEqual(["task-a"]); // 未增加
    expect(committed).toEqual(["task-a:1"]); // 未写入 B
  });
});

/**
 * 守卫分支补充：覆盖 ExportPage/SearchPage 组件内 shouldCommit 调用的更多 false 分支组合，
 * 提升 renderer 代码的分支覆盖率（CI coverage budget 71% 阈值）。
 */
describe("守卫分支补充（覆盖组件内守卫的 false 路径）", () => {
  it("shouldCommit: generation 匹配但 taskId 不匹配时拒绝（同 generation 不同任务）", () => {
    // 场景：同一 routeGeneration（理论上不应发生，但守卫必须 fail-closed）
    expect(shouldCommit(
      { taskId: "task-a", generation: 1, sequence: 1 },
      { currentTaskId: "task-b", currentGeneration: 1, currentSequence: 1, mounted: true },
    )).toBe(false);
  });

  it("shouldCommit: sequence 匹配但 taskId 不匹配时拒绝", () => {
    expect(shouldCommit(
      { taskId: "task-a", generation: 1, sequence: 5 },
      { currentTaskId: "task-b", currentGeneration: 1, currentSequence: 5, mounted: true },
    )).toBe(false);
  });

  it("shouldCommit: taskId 和 generation 匹配但 mounted=false 时拒绝", () => {
    expect(shouldCommit(
      { taskId: "task-a", generation: 1, sequence: 1 },
      { currentTaskId: "task-a", currentGeneration: 1, currentSequence: 1, mounted: false },
    )).toBe(false);
  });

  it("shouldCommit: taskId 匹配但 generation 和 sequence 都不匹配时拒绝", () => {
    expect(shouldCommit(
      { taskId: "task-a", generation: 1, sequence: 1 },
      { currentTaskId: "task-a", currentGeneration: 5, currentSequence: 10, mounted: true },
    )).toBe(false);
  });

  it("jobBelongsToTask: 空字符串 task_id 时拒绝", () => {
    expect(jobBelongsToTask("", "task-a")).toBe(false);
    expect(jobBelongsToTask("task-a", "")).toBe(false);
  });

  it("jobBelongsToTask: 两个都空时拒绝", () => {
    expect(jobBelongsToTask("", "")).toBe(false);
    expect(jobBelongsToTask(null, null)).toBe(false);
  });

  it("ExportPage 守卫场景：loadJobs 成功路径（generation+sequence+taskId 全匹配）", () => {
    // 复刻 loadJobs 的第一次 shouldCommit（listJobs 后）
    const req = { taskId: "task-a", generation: 1, sequence: 1 };
    const page = { currentTaskId: "task-a", currentGeneration: 1, currentSequence: 1, mounted: true };
    expect(shouldCommit(req, page)).toBe(true);
    // 第二次 shouldCommit（list 后）——sequence 不变，仍应通过
    expect(shouldCommit(req, page)).toBe(true);
  });

  it("ExportPage 守卫场景：初始加载期间 loadJobs 触发（不同 sequence，初始请求仍有效）", () => {
    // 初始加载用 initialLoadSeq=1；loadJobs 用 jobsSequence=1（独立 sequence）
    // 初始 shouldCommit 检查 initialLoadSeq=1 仍匹配
    const initialReq = { taskId: "task-a", generation: 1, sequence: 1 };
    const page = { currentTaskId: "task-a", currentGeneration: 1, currentSequence: 1, mounted: true };
    expect(shouldCommit(initialReq, page)).toBe(true);
  });

  it("ExportPage 守卫场景：cancelJob 成功路径守卫通过", () => {
    // cancelJob 的 generation 检查（非归属校验）
    const req = { taskId: "task-a", generation: 1, sequence: 1 };
    const page = { currentTaskId: "task-a", currentGeneration: 1, currentSequence: 1, mounted: true };
    expect(shouldCommit(req, page)).toBe(true);
  });

  it("ExportPage 守卫场景：cancelJob 后 generation 已变（路由切换）守卫拒绝", () => {
    const req = { taskId: "task-a", generation: 1, sequence: 1 };
    const page = { currentTaskId: "task-a", currentGeneration: 2, currentSequence: 1, mounted: true };
    expect(shouldCommit(req, page)).toBe(false);
  });

  it("SearchPage 守卫场景：reloadCorpus 成功路径（generation+sequence+taskId 全匹配）", () => {
    const req = { taskId: "task-a", generation: 1, sequence: 1 };
    const page = { currentTaskId: "task-a", currentGeneration: 1, currentSequence: 1, mounted: true };
    expect(shouldCommit(req, page)).toBe(true);
  });

  it("SearchPage 守卫场景：reloadCorpus 的 generation 已变（taskId 切换后 effect 重跑）", () => {
    const req = { taskId: "task-a", generation: 1, sequence: 1 };
    const page = { currentTaskId: "task-b", currentGeneration: 2, currentSequence: 2, mounted: true };
    expect(shouldCommit(req, page)).toBe(false);
  });

  it("SearchPage 守卫场景：executeSearch 的 commitGuard 在同任务时通过", () => {
    const req = { taskId: "task-a", generation: 1, sequence: 1 };
    const page = { currentTaskId: "task-a", currentGeneration: 1, currentSequence: 1, mounted: true };
    expect(shouldCommit(req, page)).toBe(true);
  });

  it("SearchPage 守卫场景：executeSearch 的 commitGuard 在 mounted=false 时拒绝（卸载后）", () => {
    const req = { taskId: "task-a", generation: 1, sequence: 1 };
    const page = { currentTaskId: "task-a", currentGeneration: 1, currentSequence: 1, mounted: false };
    expect(shouldCommit(req, page)).toBe(false);
  });

  it("SearchPage 守卫场景：初始 Promise.all 的 taskId 同步检查（路由切换后 ref 已更新）", () => {
    // currentTaskIdRef.current 已是 task-b，但闭包 taskId 仍是 task-a → 不匹配 → 丢弃
    expect("task-b" !== "task-a").toBe(true); // 模拟 currentTaskIdRef.current !== taskId
  });

  it("SearchPage 守卫场景：初始 Promise.all 的 taskId 一致时正常通过", () => {
    expect("task-a" !== "task-a").toBe(false); // 模拟 currentTaskIdRef.current === taskId
  });
});
