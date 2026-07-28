/**
 * P1-8 IPC 契约统一 — 五方集合基线测试。
 *
 * Commit 1：基于 707690c1 建立 contracts/ipc-method-audit.baseline.json 历史审计快照。
 * Commit 2：引入正式契约 contracts/engine-methods.json + electron-channels.json 后，
 *   本测试同时校验「历史审计快照未被篡改」与「当前正式契约与真实源码一致」。
 *
 * 因此本测试区分两类断言：
 *   1. 历史审计（baseline.json）—— 仍为 43/28/14/8，必须保持不变；
 *   2. 当前正式契约（engine-methods.json / electron-channels.json / MethodNameSchema）
 *      —— 必须为 42/38-3-1/71/17-41-8-5，且与真实源码 sidecar 调用、ipcMain.handle
 *      注册、Python handler 完全一致。
 *
 * Commit 3 将接入 parser registry，届时 parseMethodResult 覆盖从 28 升至 42。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import * as ts from "typescript";
import {
  MethodNameSchema,
  ENGINE_METHOD_NAMES,
  ENGINE_PUBLIC_METHOD_NAMES,
  ENGINE_INTERNAL_METHOD_NAMES,
  ENGINE_TEST_METHOD_NAMES,
} from "@shared/index";

// 测试文件位于 apps/desktop/tests/，仓库根在其上三级。
const REPO_ROOT = path.resolve(__dirname, "../../..");
const BASELINE_PATH = path.resolve(REPO_ROOT, "contracts/ipc-method-audit.baseline.json");
const ENGINE_CONTRACT_PATH = path.resolve(REPO_ROOT, "contracts/engine-methods.json");
const ELECTRON_CONTRACT_PATH = path.resolve(REPO_ROOT, "contracts/electron-channels.json");
const IPC_SCHEMA_PATH = path.resolve(REPO_ROOT, "packages/ipc-schema/src/index.ts");
const APPS_DESKTOP_SRC = path.resolve(REPO_ROOT, "apps/desktop/src");
const MAIN_IPC_DIR = path.resolve(APPS_DESKTOP_SRC, "main/ipc");

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

function loadJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, "utf-8")) as T;
}

/** 递归收集目录下所有 .ts/.tsx 文件（忽略 .d.ts），路径排序稳定。 */
function collectSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (
        st.isFile() &&
        (full.endsWith(".ts") || full.endsWith(".tsx")) &&
        !full.endsWith(".d.ts")
      ) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out.sort();
}

/**
 * 从 apps/desktop/src 扫描 sidecar.call(...) / sidecar.request(...) 的字面量方法名。
 * 仅接受字符串字面量实参；动态变量记入 dynamicHits。SidecarManager 自身内部
 * this.call / this.request 互相转发不算外部入口，但其字面量仍是真实 Engine 调用。
 */
function extractTsEngineCalls(srcRoot: string): {
  methods: Set<string>;
  dynamicHits: Array<{ file: string; line: number; snippet: string }>;
} {
  const methods = new Set<string>();
  const dynamicHits: Array<{ file: string; line: number; snippet: string }> = [];
  const files = collectSourceFiles(srcRoot);
  const callStart = /\.(call|request)\b/g;
  for (const file of files) {
    const text = readFileSync(file, "utf-8");
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m: RegExpExecArray | null;
      callStart.lastIndex = 0;
      while ((m = callStart.exec(line)) !== null) {
        let rest = line.slice(m.index + m[0].length);
        if (rest.trimStart().startsWith("<")) {
          let depth = 0;
          let j = 0;
          for (; j < rest.length; j++) {
            const ch = rest[j];
            if (ch === "<") depth++;
            else if (ch === ">") {
              depth--;
              if (depth === 0) break;
            }
          }
          rest = rest.slice(j + 1);
        }
        const trimmed = rest.trimStart();
        if (!trimmed.startsWith("(")) continue;
        const afterParen = trimmed.slice(1).trimStart();
        let token = "";
        for (const ch of afterParen) {
          if (ch === "," || ch === ")") break;
          token += ch;
        }
        token = token.trim();
        const litDouble = token.match(/^"([^"]*)"$/);
        const litSingle = token.match(/^'([^']*)'$/);
        if (litDouble) {
          methods.add(litDouble[1]);
        } else if (litSingle) {
          methods.add(litSingle[1]);
        } else {
          dynamicHits.push({
            file: path.relative(REPO_ROOT, file).replace(/\\/g, "/"),
            line: i + 1,
            snippet: line.trim().slice(0, 160),
          });
        }
      }
    }
  }
  return { methods, dynamicHits };
}

/** 从 ipc-schema 截取 parseMethodResult 函数体提取覆盖方法名。 */
function extractParseMethodResultCovered(schemaPath: string): Set<string> {
  const src = readFileSync(schemaPath, "utf-8");
  const start = src.indexOf("export function parseMethodResult(");
  expect(start, "parseMethodResult 函数应存在于 ipc-schema").toBeGreaterThan(-1);
  const braceOpen = src.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = braceOpen; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  expect(end, "parseMethodResult 函数体应正确闭合").toBeGreaterThan(-1);
  const body = src.slice(braceOpen, end);
  const covered = new Set<string>();
  for (const m of body.matchAll(/===\s*"([^"]+)"/g)) {
    covered.add(m[1]);
  }
  for (const m of body.matchAll(/\[\s*([^\]]*?)\s*\]\.includes\(method\)/g)) {
    for (const s of m[1].matchAll(/"([^"]+)"/g)) {
      covered.add(s[1]);
    }
  }
  return covered;
}

interface IpcMainRegistration {
  channel: string;
  file: string;
  hasSidecarCall: boolean;
  hasInspectTask: boolean;
}

/**
 * 递归扫描 apps/desktop/src/main/ipc/ 下所有 .ts 文件，提取 ipcMain.handle 注册。
 * 不使用固定文件清单，未来新增 IPC 文件自动纳入。
 */
function extractIpcMainHandlers(): IpcMainRegistration[] {
  const out: IpcMainRegistration[] = [];
  const files = collectSourceFiles(MAIN_IPC_DIR);
  for (const file of files) {
    const text = readFileSync(file, "utf-8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, /*setParentNodes*/ true);
    const visit = (node: ts.Node) => {
      if (
        ts.isExpressionStatement(node) &&
        ts.isCallExpression(node.expression) &&
        ts.isPropertyAccessExpression(node.expression.expression) &&
        node.expression.expression.name.text === "handle" &&
        ts.isIdentifier(node.expression.expression.expression) &&
        node.expression.expression.expression.text === "ipcMain"
      ) {
        const call = node.expression;
        const channelArg = call.arguments[0];
        const callbackArg = call.arguments[1];
        if (callbackArg && ts.isStringLiteral(channelArg)) {
          const { hasSidecarCall, hasInspectTask } = classifyCallback(callbackArg);
          out.push({
            channel: channelArg.text,
            file: path.relative(MAIN_IPC_DIR, file).replace(/\\/g, "/"),
            hasSidecarCall,
            hasInspectTask,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

function classifyCallback(root: ts.Node): { hasSidecarCall: boolean; hasInspectTask: boolean } {
  let hasSidecarCall = false;
  let hasInspectTask = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === "call" || node.expression.name.text === "request") &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "sidecar"
    ) {
      hasSidecarCall = true;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "inspectTask"
    ) {
      hasInspectTask = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return { hasSidecarCall, hasInspectTask };
}

function sorted(arr: Iterable<string>): string[] {
  return [...arr].sort();
}

function diffSets(actual: Iterable<string>, expected: Iterable<string>): { missing: string[]; extra: string[] } {
  const a = new Set(actual);
  const e = new Set(expected);
  const missing = sorted([...e].filter((x) => !a.has(x)));
  const extra = sorted([...a].filter((x) => !e.has(x)));
  return { missing, extra };
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
    // 生成的分类 tuple 与契约一致
    expect(ENGINE_PUBLIC_METHOD_NAMES.length).toBe(38);
    expect(ENGINE_INTERNAL_METHOD_NAMES.length).toBe(3);
    expect(ENGINE_TEST_METHOD_NAMES.length).toBe(1);
  });

  it("Commit 1 历史漂移已在正式契约中解决", () => {
    const contractMethods = new Set(engineContract.engine_methods.map((m) => m.method));
    // 已移除的非 Engine 方法
    for (const m of ["files.openOriginal", "files.openFolder", "settings.get", "settings.update"]) {
      expect(contractMethods.has(m), `${m} 不应在正式契约中`).toBe(false);
      expect(MethodNameSchema.safeParse(m).success, `${m} 不应在 MethodNameSchema 中`).toBe(false);
    }
    // 已补入的 Engine 方法
    for (const m of ["app.shutdown", "tasks.inspectState", "demo.create"]) {
      expect(contractMethods.has(m), `${m} 应在正式契约中`).toBe(true);
      expect(MethodNameSchema.safeParse(m).success, `${m} 应在 MethodNameSchema 中`).toBe(true);
    }
  });

  it("TS 真实 sidecar 调用集合 = 正式契约 Engine 方法集合（42）", () => {
    const { methods, dynamicHits } = extractTsEngineCalls(APPS_DESKTOP_SRC);
    const allowedDynamic = dynamicHits.filter((h) =>
      /main\/sidecar\/manager\.(ts|tsx)$/.test(h.file.replace(/\\/g, "/")),
    );
    const disallowedDynamic = dynamicHits.filter(
      (h) => !/main\/sidecar\/manager\.(ts|tsx)$/.test(h.file.replace(/\\/g, "/")),
    );
    expect(disallowedDynamic, "非 SidecarManager 内部的动态 method 调用").toEqual([]);
    expect(allowedDynamic.length).toBe(1); // manager.ts call→request 内部转发

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

    // 源码总数
    expect(registrations.length, "真实 ipcMain.handle 注册总数应为 71").toBe(71);
    // 源码无重复
    const sourceDupes = sorted(sourceChannels.filter((c, i) => sourceChannels.indexOf(c) !== i));
    expect(sourceDupes, "源码中不应有重复注册的 channel").toEqual([]);

    // 分类
    const classified = {
      electron_local: new Set<string>(),
      electron_forwarded: new Set<string>(),
      electron_test_local: new Set<string>(),
      electron_test_forwarded: new Set<string>(),
    };
    for (const r of registrations) {
      const isTest = r.channel.startsWith("test.");
      const bucket = isTest
        ? (r.hasSidecarCall || r.hasInspectTask ? "electron_test_forwarded" : "electron_test_local")
        : (r.hasSidecarCall ? "electron_forwarded" : "electron_local");
      classified[bucket].add(r.channel);
    }

    // 与正式契约比对（全量 + 分桶）
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

    for (const [bucket, set] of Object.entries(classified)) {
      expect(set.size, `${bucket} 数量`).toBe(
        bucket === "electron_local" ? 17 : bucket === "electron_forwarded" ? 41 : bucket === "electron_test_local" ? 8 : 5,
      );
    }

    // 边界：local/test_local 不应是 Engine 方法
    const engineContract = loadJson<EngineContract>(ENGINE_CONTRACT_PATH);
    const engineMethods = new Set(engineContract.engine_methods.map((m) => m.method));
    const localCollide = sorted(
      [...classified.electron_local, ...classified.electron_test_local].filter((c) => engineMethods.has(c)),
    );
    expect(localCollide, "electron_local ∪ test_local 不应是 Engine 方法").toEqual([]);
  });
});

describe("IPC 契约基线 — Commit 3 待解决差异（parser 仍未穷尽）", () => {
  const baseline = loadJson<HistoricalBaseline>(BASELINE_PATH);

  it("Commit 2 未改 parseMethodResult，实时覆盖仍为 28，缺口仍为 14", () => {
    const covered = extractParseMethodResultCovered(IPC_SCHEMA_PATH);
    expect(covered.size, "parseMethodResult 当前覆盖应为 28（Commit 3 升至 42）").toBe(28);
    const { missing, extra } = diffSets(covered, baseline.parse_method_result_covered);
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });

    // 缺口 = 当前 42 个 Engine 方法 - 28 覆盖 = 14
    const engineMethods = new Set(ENGINE_METHOD_NAMES);
    const gap = sorted([...engineMethods].filter((m) => !covered.has(m)));
    expect(gap.length, "缺 parser 的 Engine 方法数量应为 14（Commit 3 补齐）").toBe(14);
  });
});
