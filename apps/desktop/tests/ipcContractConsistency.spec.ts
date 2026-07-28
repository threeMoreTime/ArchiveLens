/**
 * P1-8 Commit 4 — 正式 IPC 契约一致性测试。
 *
 * 锁定以下链路，任何漂移在本测试失败：
 *   contracts/engine-methods.json
 *     ↕ generated EngineMethodName / MethodNameSchema
 *     ↕ ENGINE_RESULT_PARSERS / RESULT_SCHEMA_REGISTRY
 *     ↕ SidecarManager.call/request 真实调用
 *     ↕ Python ENGINE_HANDLERS（由 Python 端 test_ipc_contract_consistency.py 互验）
 *   contracts/electron-channels.json
 *     ↕ Electron Main ipcMain.handle 注册
 *     ↕ Main handler 实际转发的 Engine method
 *     ↕ Preload ipcRenderer.invoke 暴露
 *     ↕ ARCHIVELENS_E2E 条件边界
 *
 * 与 ipcMethodBaseline.spec.ts 的区别：baseline 锁定历史快照（707690c1），
 * 本测试锁定当前正式契约与真实源码的实时一致性。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  MethodNameSchema,
  ENGINE_METHOD_NAMES,
  ENGINE_METHOD_RESULT_CONTRACT,
  ENGINE_RESULT_PARSERS,
  ENGINE_PARAM_SCHEMA_IDS,
  ENGINE_RESULT_SCHEMA_IDS,
  PARAM_SCHEMA_REGISTRY,
  RESULT_SCHEMA_REGISTRY,
} from "@shared/index";
import {
  REPO_ROOT,
  APPS_DESKTOP_SRC,
  extractTsEngineCalls,
  extractIpcMainHandlers,
  extractPreloadInvokes,
  diffSets,
  sorted,
} from "./helpers/ipcContractAst";

interface EngineMethodContract {
  method: string;
  visibility: "engine_public" | "engine_internal" | "engine_test";
  params: { kind: string; schema_id?: string };
  result: { kind: string; schema_id?: string };
  python_handler: string;
}
interface EngineContract {
  schema_version: number;
  protocol_version: number;
  engine_methods: EngineMethodContract[];
}
interface ElectronChannelContract {
  channel: string;
  kind: "electron_local" | "electron_forwarded" | "electron_test_local" | "electron_test_forwarded";
  engine_method?: string;
  preload_exposed?: boolean;
  preload_exposed_in_e2e_only?: boolean;
}
interface ElectronContract {
  schema_version: number;
  channels: ElectronChannelContract[];
}

function loadEngineContract(): EngineContract {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, "contracts/engine-methods.json"), "utf-8"));
}
function loadElectronContract(): ElectronContract {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, "contracts/electron-channels.json"), "utf-8"));
}

describe("P1-8 Commit 4 — Engine 六方集合一致（均为 42）", () => {
  const engine = loadEngineContract();
  const contractMethods = new Set(engine.engine_methods.map((m) => m.method));
  const contractKeys = new Set(Object.keys(ENGINE_METHOD_RESULT_CONTRACT));
  const parserKeys = new Set(Object.keys(ENGINE_RESULT_PARSERS));
  const schemaOptions = new Set(MethodNameSchema.options);

  it("engine-methods.json method = ENGINE_METHOD_NAMES = MethodNameSchema.options = CONTRACT keys = PARSER keys", () => {
    expect(contractMethods.size).toBe(42);
    expect(ENGINE_METHOD_NAMES.length).toBe(42);
    expect(schemaOptions.size).toBe(42);
    expect(contractKeys.size).toBe(42);
    expect(parserKeys.size).toBe(42);

    const d1 = diffSets(contractMethods, ENGINE_METHOD_NAMES);
    expect(d1, `契约 method vs ENGINE_METHOD_NAMES\n  Missing: ${d1.missing}\n  Extra: ${d1.extra}`).toEqual({ missing: [], extra: [] });

    const d2 = diffSets(schemaOptions, ENGINE_METHOD_NAMES);
    expect(d2, `MethodNameSchema vs ENGINE_METHOD_NAMES\n  Missing: ${d2.missing}\n  Extra: ${d2.extra}`).toEqual({ missing: [], extra: [] });

    const d3 = diffSets(contractKeys, ENGINE_METHOD_NAMES);
    expect(d3, `CONTRACT keys vs ENGINE_METHOD_NAMES\n  Missing: ${d3.missing}\n  Extra: ${d3.extra}`).toEqual({ missing: [], extra: [] });

    const d4 = diffSets(parserKeys, ENGINE_METHOD_NAMES);
    expect(d4, `PARSER keys vs ENGINE_METHOD_NAMES\n  Missing: ${d4.missing}\n  Extra: ${d4.extra}`).toEqual({ missing: [], extra: [] });
  });

  it("真实 sidecar.call/request 字面量方法集合 = 42 个 Engine 方法", () => {
    // 扫描整个 apps/desktop/src（含 manager.ts 的 app.shutdown 内部握手）
    const { methods: realCalls, dynamicHits } = extractTsEngineCalls(APPS_DESKTOP_SRC);
    const disallowedDynamic = dynamicHits.filter(
      (h) => !/main\/sidecar\/manager\.(ts|tsx)$/.test(h.file.replace(/\\/g, "/")),
    );
    expect(disallowedDynamic, "非 SidecarManager 内部的动态 method 调用").toEqual([]);
    expect(realCalls.size).toBe(42);
    const d = diffSets(realCalls, contractMethods);
    expect(d, `真实调用 vs 契约\n  Missing: ${d.missing}\n  Extra: ${d.extra}`).toEqual({ missing: [], extra: [] });
  });
});

describe("P1-8 Commit 4 — schema registry 一致", () => {
  const engine = loadEngineContract();

  it("契约 params schema_id == ENGINE_PARAM_SCHEMA_IDS == PARAM_SCHEMA_REGISTRY keys（14）", () => {
    const contractParamIds = new Set<string>();
    for (const m of engine.engine_methods) {
      if (m.params.kind === "schema" && m.params.schema_id) {
        contractParamIds.add(m.params.schema_id);
      }
    }
    const registryKeys = new Set(Object.keys(PARAM_SCHEMA_REGISTRY));
    expect(contractParamIds.size).toBe(14);
    expect(ENGINE_PARAM_SCHEMA_IDS.length).toBe(14);
    expect(registryKeys.size).toBe(14);
    expect(diffSets(contractParamIds, ENGINE_PARAM_SCHEMA_IDS)).toEqual({ missing: [], extra: [] });
    expect(diffSets(registryKeys, ENGINE_PARAM_SCHEMA_IDS)).toEqual({ missing: [], extra: [] });
  });

  it("契约 result schema_id == ENGINE_RESULT_SCHEMA_IDS == RESULT_SCHEMA_REGISTRY keys（34）", () => {
    const contractResultIds = new Set<string>();
    for (const m of engine.engine_methods) {
      if (m.result.kind === "schema" && m.result.schema_id) {
        contractResultIds.add(m.result.schema_id);
      }
    }
    const registryKeys = new Set(Object.keys(RESULT_SCHEMA_REGISTRY));
    expect(contractResultIds.size).toBe(34);
    expect(ENGINE_RESULT_SCHEMA_IDS.length).toBe(34);
    expect(registryKeys.size).toBe(34);
    expect(diffSets(contractResultIds, ENGINE_RESULT_SCHEMA_IDS)).toEqual({ missing: [], extra: [] });
    expect(diffSets(registryKeys, ENGINE_RESULT_SCHEMA_IDS)).toEqual({ missing: [], extra: [] });
  });
});

describe("P1-8 Commit 4 — parser 与 schema 对象身份一致（42/42）", () => {
  it("每个方法的 ENGINE_RESULT_PARSERS[method] === RESULT_SCHEMA_REGISTRY[contract.schemaId]", () => {
    let checked = 0;
    for (const method of ENGINE_METHOD_NAMES) {
      const resultContract = ENGINE_METHOD_RESULT_CONTRACT[method];
      if (resultContract.kind !== "schema") {
        throw new Error(`当前方法出现未实现的 result kind: ${method}`);
      }
      expect(
        ENGINE_RESULT_PARSERS[method],
        `${method} parser 未引用契约声明的 schema`,
      ).toBe(RESULT_SCHEMA_REGISTRY[resultContract.schemaId]);
      checked += 1;
    }
    expect(checked).toBe(42);
  });
});

describe("P1-8 Commit 4 — Main handler 精确映射核验", () => {
  const electron = loadElectronContract();
  const handlers = extractIpcMainHandlers();
  const handlerByChannel = new Map(handlers.map((h) => [h.channel, h]));

  it("真实 ipcMain.handle 注册 = electron-channels.json（71），分类 17/41/8/5", () => {
    expect(handlers.length).toBe(71);
    const sourceDupes = sorted(handlers.map((h) => h.channel).filter((c, i, arr) => arr.indexOf(c) !== i));
    expect(sourceDupes, "源码无重复注册").toEqual([]);

    const classify = (h: (typeof handlers)[number]) => {
      const isTest = h.channel.startsWith("test.");
      if (isTest) return h.hasSidecarCall || h.hasInspectTask ? "electron_test_forwarded" : "electron_test_local";
      return h.hasSidecarCall ? "electron_forwarded" : "electron_local";
    };
    const counts = { electron_local: 0, electron_forwarded: 0, electron_test_local: 0, electron_test_forwarded: 0 };
    for (const h of handlers) counts[classify(h) as keyof typeof counts] += 1;
    expect(counts).toEqual({ electron_local: 17, electron_forwarded: 41, electron_test_local: 8, electron_test_forwarded: 5 });

    const d = diffSets(handlers.map((h) => h.channel), electron.channels.map((c) => c.channel));
    expect(d, `源码注册 vs 契约\n  Missing: ${d.missing}\n  Extra: ${d.extra}`).toEqual({ missing: [], extra: [] });
  });

  it("每个 forwarded handler 精确映射到契约声明的 engine_method", () => {
    const forwarded = electron.channels.filter(
      (c) => c.kind === "electron_forwarded" || c.kind === "electron_test_forwarded",
    );
    expect(forwarded.length).toBe(46); // 41 + 5

    for (const c of forwarded) {
      const h = handlerByChannel.get(c.channel);
      expect(h, `源码缺失 ${c.channel} 注册`).toBeDefined();
      if (!h) continue;

      // 无动态 method
      expect(h.hasDynamicMethod, `${c.channel} 回调含动态 method 变量`).toBe(false);

      if (c.channel.startsWith("test.task.")) {
        // test.task.* 经 inspectTask 间接调用 tasks.inspectState
        expect(h.inspectTaskCallCount, `${c.channel} 应调用 inspectTask`).toBe(1);
        expect(c.engine_method, `${c.channel} 应映射 tasks.inspectState`).toBe("tasks.inspectState");
        // 直接 sidecar 调用由 inspectTask 内部完成，handler 回调体本身无 sidecar.call
        expect(h.directEngineMethods, `${c.channel} 回调不应直接 sidecar.call`).toEqual([]);
      } else {
        // 生产 forwarded：恰好 1 个直接 sidecar.call 字面量
        expect(h.directEngineMethods.length, `${c.channel} 应恰好 1 个 sidecar.call`).toBe(1);
        expect(h.directEngineMethods[0], `${c.channel} engine_method 映射不一致`).toBe(c.engine_method);
      }
    }
  });

  it("五个别名精确映射", () => {
    const aliasMap: Record<string, string> = {
      "app.getInfo": "app.info",
      "app.getEnvironment": "diagnostics.run",
      "app.cleanupTemporaryData": "storage.cleanupTemporary",
      "tasks.openCleanupDir": "tasks.cleanupTarget",
      "exports.openDirectory": "exports.get",
    };
    for (const [channel, engineMethod] of Object.entries(aliasMap)) {
      const h = handlerByChannel.get(channel);
      expect(h, `源码缺失 ${channel}`).toBeDefined();
      expect(h?.directEngineMethods, `${channel} → ${engineMethod}`).toContain(engineMethod);
    }
  });

  it("local handler 解析出 0 个 sidecar method", () => {
    const locals = electron.channels.filter(
      (c) => c.kind === "electron_local" || c.kind === "electron_test_local",
    );
    for (const c of locals) {
      const h = handlerByChannel.get(c.channel);
      expect(h, `源码缺失 ${c.channel}`).toBeDefined();
      expect(h?.directEngineMethods, `${c.channel} 不应含 sidecar 调用`).toEqual([]);
      expect(h?.hasInspectTask, `${c.channel} 不应含 inspectTask`).toBe(false);
    }
  });
});

describe("P1-8 Commit 4 — Preload 暴露边界", () => {
  const electron = loadElectronContract();
  const invokes = extractPreloadInvokes();

  it("真实 Preload invoke = 71（生产 58 / E2E 13），无动态变量，无重复", () => {
    expect(invokes.length).toBe(71);
    expect(invokes.every((i) => i.isLiteral), "invoke 实参必须为字面量").toBe(true);
    const channels = invokes.map((i) => i.channel);
    const dupes = sorted(channels.filter((c, i, arr) => arr.indexOf(c) !== i));
    expect(dupes, "Preload 无重复暴露").toEqual([]);
  });

  it("生产 invoke 集 == 契约 preload_exposed===true 通道（58）", () => {
    const prodInvokes = new Set(invokes.filter((i) => !i.inE2eBranch).map((i) => i.channel));
    const contractProd = new Set(
      electron.channels.filter((c) => c.preload_exposed === true).map((c) => c.channel),
    );
    expect(prodInvokes.size).toBe(58);
    expect(contractProd.size).toBe(58);
    const d = diffSets(prodInvokes, contractProd);
    expect(d, `生产 invoke vs 契约\n  Missing: ${d.missing}\n  Extra: ${d.extra}`).toEqual({ missing: [], extra: [] });
  });

  it("E2E invoke 集 == 契约 preload_exposed_in_e2e_only===true 通道（13）", () => {
    const e2eInvokes = new Set(invokes.filter((i) => i.inE2eBranch).map((i) => i.channel));
    const contractE2e = new Set(
      electron.channels.filter((c) => c.preload_exposed_in_e2e_only === true).map((c) => c.channel),
    );
    expect(e2eInvokes.size).toBe(13);
    expect(contractE2e.size).toBe(13);
    const d = diffSets(e2eInvokes, contractE2e);
    expect(d, `E2E invoke vs 契约\n  Missing: ${d.missing}\n  Extra: ${d.extra}`).toEqual({ missing: [], extra: [] });
  });

  it("visibility 边界：engine_test 不被生产暴露，settings.* 不入 Engine methods", () => {
    const engine = loadEngineContract();
    const engineMethods = new Set(engine.engine_methods.map((m) => m.method));

    // 生产 forwarded 通道不得直接暴露 tasks.inspectState
    const prodForwardedTargets = new Set(
      electron.channels
        .filter((c) => c.kind === "electron_forwarded")
        .map((c) => c.engine_method),
    );
    expect(prodForwardedTargets.has("tasks.inspectState"), "生产 forwarded 不得映射 tasks.inspectState").toBe(false);

    // app.shutdown 不出现在 Preload invoke
    const allInvokeChannels = new Set(invokes.map((i) => i.channel));
    // app.shutdown 是 Main→Engine 内部握手，无对应 Preload 通道
    expect(allInvokeChannels.has("app.shutdown"), "app.shutdown 不应在 Preload invoke").toBe(false);

    // settings.* 不在 Engine methods
    for (const m of ["settings.get", "settings.update", "settings.getDeveloperMode", "settings.setDeveloperMode"]) {
      expect(engineMethods.has(m), `${m} 不应是 Engine 方法`).toBe(false);
    }
  });
});
