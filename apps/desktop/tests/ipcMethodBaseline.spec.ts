/**
 * P1-8 IPC 契约统一 — 五方集合基线测试。
 *
 * Commit 1：基于 707690c1 建立 contracts/ipc-method-audit.baseline.json 历史审计快照。
 * Commit 2：引入正式契约 contracts/engine-methods.json + electron-channels.json 后，
 *   本测试同时校验「历史审计快照未被篡改」与「当前正式契约与真实源码一致」。
 * Commit 4：AST 扫描逻辑迁移至 helpers/ipcContractAst.ts，供本测试与
 *   ipcContractConsistency.spec.ts 共用。
 *
 * 区分两类断言：
 *   1. 历史审计（baseline.json）—— 仍为 43/28/14/8，必须保持不变；
 *   2. 当前正式契约 —— 42/38-3-1/71/17-41-8-5，且与真实源码一致。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  MethodNameSchema,
  ENGINE_METHOD_NAMES,
  ENGINE_RESULT_PARSERS,
} from "@shared/index";
import {
  REPO_ROOT,
  APPS_DESKTOP_SRC,
  extractTsEngineCalls,
  extractIpcMainHandlers,
  diffSets,
} from "./helpers/ipcContractAst";

const BASELINE_PATH = path.resolve(REPO_ROOT, "contracts/ipc-method-audit.baseline.json");
const ENGINE_CONTRACT_PATH = path.resolve(REPO_ROOT, "contracts/engine-methods.json");
const ELECTRON_CONTRACT_PATH = path.resolve(REPO_ROOT, "contracts/electron-channels.json");

interface BaselineDifference {
  id: string;
  kind: "schema_only_vs_python" | "python_only_vs_schema" | "engine_methods_missing_parser";
  item: string;
  issue: string;
  resolve_in_commit: number;
  methods?: string[];
  target_visibility?: string;
}
interface HistoricalBaseline {
  schema_version: number;
  method_name_schema: string[];
  typescript_engine_calls: string[];
  parse_method_result_covered: string[];
  python_handlers: string[];
  electron_local_channels: string[];
  electron_forwarded_channels: string[];
  electron_test_local_channels: string[];
  electron_test_forwarded_channels: string[];
  known_differences: BaselineDifference[];
}
interface EngineContract {
  schema_version: number;
  protocol_version: number;
  engine_methods: Array<{ method: string; visibility: string }>;
}
interface ElectronContract {
  schema_version: number;
  channels: Array<{ channel: string; kind: string }>;
}

function loadJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, "utf-8")) as T;
}

describe("IPC 契约基线 — 历史审计快照（707690c1，必须保持不变）", () => {
  const baseline = loadJson<HistoricalBaseline>(BASELINE_PATH);

  it("历史 baseline 数量锁定：schema 43 / TS 调用 42 / parser 覆盖 28 / Python handler 42", () => {
    expect(baseline.method_name_schema.length).toBe(43);
    expect(baseline.typescript_engine_calls.length).toBe(42);
    expect(baseline.parse_method_result_covered.length).toBe(28);
    expect(baseline.python_handlers.length).toBe(42);
    expect(baseline.electron_local_channels.length).toBe(17);
    expect(baseline.electron_forwarded_channels.length).toBe(41);
    expect(baseline.electron_test_local_channels.length).toBe(8);
    expect(baseline.electron_test_forwarded_channels.length).toBe(5);
    expect(baseline.known_differences.length).toBe(8);
  });

  it("历史 baseline known_differences：resolve_in_commit 合法、id 唯一", () => {
    const ids = new Set<string>();
    for (const d of baseline.known_differences) {
      expect(Number.isInteger(d.resolve_in_commit)).toBe(true);
      expect(d.resolve_in_commit).toBeGreaterThanOrEqual(1);
      expect(d.resolve_in_commit).toBeLessThanOrEqual(5);
      expect(d.id.length).toBeGreaterThan(0);
      expect(ids.has(d.id), `重复 id: ${d.id}`).toBe(false);
      ids.add(d.id);
    }
  });

  it("历史 baseline 数组无重复", () => {
    const arrayKeys = [
      "method_name_schema",
      "typescript_engine_calls",
      "parse_method_result_covered",
      "python_handlers",
      "electron_local_channels",
      "electron_forwarded_channels",
      "electron_test_local_channels",
      "electron_test_forwarded_channels",
    ] as const;
    for (const key of arrayKeys) {
      const values = baseline[key];
      expect(new Set(values).size, `baseline.${key} 不应重复`).toBe(values.length);
    }
  });
});

describe("IPC 正式契约 — Engine 方法（Commit 2 后当前状态）", () => {
  const engineContract = loadJson<EngineContract>(ENGINE_CONTRACT_PATH);

  it("MethodNameSchema 已由生成 tuple 派生，共 42 项", () => {
    expect(ENGINE_METHOD_NAMES.length).toBe(42);
    expect(MethodNameSchema.options.length).toBe(42);
    expect(MethodNameSchema.options).toEqual([...ENGINE_METHOD_NAMES]);
  });

  it("正式契约 engine_methods 共 42 项，分类 38/3/1", () => {
    expect(engineContract.protocol_version).toBe(4);
    expect(engineContract.engine_methods.length).toBe(42);
    const visibility = (v: string) => engineContract.engine_methods.filter((m) => m.visibility === v).length;
    expect(visibility("engine_public")).toBe(38);
    expect(visibility("engine_internal")).toBe(3);
    expect(visibility("engine_test")).toBe(1);
  });

  it("Commit 1 历史漂移已在正式契约中解决", () => {
    const contractMethods = new Set(engineContract.engine_methods.map((m) => m.method));
    for (const m of ["files.openOriginal", "files.openFolder", "settings.get", "settings.update"]) {
      expect(contractMethods.has(m), `${m} 不应在正式契约中`).toBe(false);
      expect(MethodNameSchema.safeParse(m).success, `${m} 不应在 MethodNameSchema 中`).toBe(false);
    }
    for (const m of ["app.shutdown", "tasks.inspectState", "demo.create"]) {
      expect(contractMethods.has(m), `${m} 应在正式契约中`).toBe(true);
      expect(MethodNameSchema.safeParse(m).success, `${m} 应在 MethodNameSchema 中`).toBe(true);
    }
  });

  it("TS 真实 sidecar 调用集合 = 正式契约 Engine 方法集合（42）", () => {
    const { methods, dynamicHits } = extractTsEngineCalls(APPS_DESKTOP_SRC);
    // 唯一允许的动态内部转发：SidecarManager.call(...) 内部 this.request(method, ...)
    // 精确限定为 receiver=this / method=request / enclosingClass=SidecarManager / enclosingMethod=call。
    const isAllowedInternalForward = (h: { receiver: string; method: string; enclosingClass: string | null; enclosingMethod: string | null }) =>
      h.receiver === "this" &&
      h.method === "request" &&
      h.enclosingClass === "SidecarManager" &&
      h.enclosingMethod === "call";
    const allowedDynamic = dynamicHits.filter(isAllowedInternalForward);
    const disallowedDynamic = dynamicHits.filter((h) => !isAllowedInternalForward(h));
    expect(
      disallowedDynamic.map((h) => `${h.file}:${h.line}:${h.column} ${h.receiver}.${h.method} in ${h.enclosingClass}.${h.enclosingMethod}`),
      "非允许的动态 Engine method 调用（仅允许 SidecarManager.call 内 this.request 转发）",
    ).toEqual([]);
    expect(allowedDynamic.length, "允许的动态内部转发应恰好 1 处").toBe(1);

    expect(methods.size).toBe(42);
    const contractMethods = new Set(engineContract.engine_methods.map((m) => m.method));
    const d = diffSets(methods, contractMethods);
    expect(d, `TS 调用与契约不一致\n  Missing: ${d.missing}\n  Extra: ${d.extra}`).toEqual({ missing: [], extra: [] });
  });
});

describe("IPC 正式契约 — Electron 通道（Commit 2 后当前状态）", () => {
  const electronContract = loadJson<ElectronContract>(ELECTRON_CONTRACT_PATH);

  it("electron-channels.json 共 71 项，分类 17/41/8/5", () => {
    expect(electronContract.channels.length).toBe(71);
    const count = (k: string) => electronContract.channels.filter((c) => c.kind === k).length;
    expect(count("electron_local")).toBe(17);
    expect(count("electron_forwarded")).toBe(41);
    expect(count("electron_test_local")).toBe(8);
    expect(count("electron_test_forwarded")).toBe(5);
  });

  it("真实源码 ipcMain.handle 注册（递归扫描 main/ipc）= 正式契约 = 历史 baseline（71）", () => {
    const registrations = extractIpcMainHandlers();
    const sourceChannels = registrations.map((r) => r.channel);

    expect(registrations.length, "真实 ipcMain.handle 注册总数应为 71").toBe(71);
    const sourceDupes = sourceChannels.filter((c, i) => sourceChannels.indexOf(c) !== i).sort();
    expect(sourceDupes, "源码中不应有重复注册的 channel").toEqual([]);

    const contractChannels = electronContract.channels.map((c) => c.channel);
    const fullDiff = diffSets(sourceChannels, contractChannels);
    expect(fullDiff, `源码与正式契约不一致\n  Missing: ${fullDiff.missing}\n  Extra: ${fullDiff.extra}`).toEqual({ missing: [], extra: [] });

    const baseline = loadJson<HistoricalBaseline>(BASELINE_PATH);
    const baselineAll = [
      ...baseline.electron_local_channels,
      ...baseline.electron_forwarded_channels,
      ...baseline.electron_test_local_channels,
      ...baseline.electron_test_forwarded_channels,
    ];
    const baselineDiff = diffSets(sourceChannels, baselineAll);
    expect(baselineDiff, `源码与历史 baseline 不一致\n  Missing: ${baselineDiff.missing}\n  Extra: ${baselineDiff.extra}`).toEqual({ missing: [], extra: [] });
  });
});

describe("IPC 契约基线 — parser 覆盖（历史 28 → 当前 42）", () => {
  const baseline = loadJson<HistoricalBaseline>(BASELINE_PATH);

  it("历史快照：parse_method_result_covered = 28（707690c1 审计记录，不变）", () => {
    expect(baseline.parse_method_result_covered.length).toBe(28);
  });

  it("当前实现：ENGINE_RESULT_PARSERS 覆盖全部 42 个 Engine 方法，缺口为 0", () => {
    const parserKeys = new Set(Object.keys(ENGINE_RESULT_PARSERS));
    const engineMethods = new Set(ENGINE_METHOD_NAMES);
    expect(parserKeys.size).toBe(42);
    expect(engineMethods.size).toBe(42);
    const d = diffSets(parserKeys, engineMethods);
    expect(d, `parser 覆盖与 Engine 方法不一致\n  Missing: ${d.missing}\n  Extra: ${d.extra}`).toEqual({ missing: [], extra: [] });
    const gap = [...engineMethods].filter((m) => !parserKeys.has(m)).sort();
    expect(gap, "Commit 3 后 parser 缺口应为 0").toEqual([]);
  });
});
