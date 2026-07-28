/**
 * P1-8 IPC 契约统一 — Commit 1 基线测试。
 *
 * 作用：把当前真实代码的五方集合（MethodNameSchema / TS Engine 调用 /
 * parseMethodResult 覆盖 / Python handlers / Electron 通道）与
 * `contracts/ipc-method-audit.baseline.json` 锁定，使后续 commit 引入的任何
 * 未建模漂移都会在本测试失败。
 *
 * 本测试只读取与比对，不修改生产 IPC 行为。known_differences 中记录的差异
 * 将在 Commit 2（schema 收敛）与 Commit 3（parser 收敛）解决。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import * as ts from "typescript";
import { MethodNameSchema } from "@shared/index";

// 测试文件位于 apps/desktop/tests/，仓库根在其上三级。
const REPO_ROOT = path.resolve(__dirname, "../../..");
const BASELINE_PATH = path.resolve(REPO_ROOT, "contracts/ipc-method-audit.baseline.json");
const IPC_SCHEMA_PATH = path.resolve(REPO_ROOT, "packages/ipc-schema/src/index.ts");
const APPS_DESKTOP_SRC = path.resolve(REPO_ROOT, "apps/desktop/src");
const MAIN_IPC_DIR = path.resolve(APPS_DESKTOP_SRC, "main/ipc");
const MAIN_IPC_FILES = ["app.ts", "engine.ts", "settings.ts", "e2e.ts"];

interface BaselineDifference {
  id: string;
  kind: "schema_only_vs_python" | "python_only_vs_schema" | "engine_methods_missing_parser";
  item: string;
  issue: string;
  resolve_in_commit: number;
  methods?: string[];
  target_visibility?: string;
}

interface Baseline {
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

function loadBaseline(): Baseline {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf-8")) as Baseline;
}

/** 递归收集目录下所有 .ts/.tsx 文件的相对路径。 */
function collectSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx"))) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

/**
 * 从 apps/desktop/src 扫描 sidecar.call(...) / sidecar.request(...) 的字面量方法名。
 *
 * - 仅接受字符串字面量实参；
 * - SidecarManager 自身实现内部的 this.call / this.request 互相转发不算外部入口，
 *   但其中的字面量（如 manager.ts:465 的 "app.shutdown"）仍是真实 Engine 调用，需计入。
 * - 动态变量作为方法名时，记入 dynamicHits 并由调用方决定是否失败。
 */
function extractTsEngineCalls(srcRoot: string): {
  methods: Set<string>;
  dynamicHits: Array<{ file: string; line: number; snippet: string }>;
} {
  const methods = new Set<string>();
  const dynamicHits: Array<{ file: string; line: number; snippet: string }> = [];
  const files = collectSourceFiles(srcRoot);
  // 匹配 .call 或 .request，后接可选泛型 <...>，再接 (
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
        // 跳过可选泛型 <...>
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
        if (!trimmed.startsWith("(")) continue; // 不是调用形式
        const afterParen = trimmed.slice(1).trimStart();
        // 取到第一个 , 或 ) 为止
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
          // 动态变量：可能是 SidecarManager 内部 this.request(method,...) 转发
          // 该入口不视为外部未知调用（method 来自上层 call 的字面量），
          // 但仍记录以便审计；调用方按文件路径过滤 SidecarManager 自身实现。
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

/**
 * 从 packages/ipc-schema/src/index.ts 截取 parseMethodResult 函数体，
 * 提取其覆盖的方法名（method === "x" 与 ["a","b"].includes(method) 两种形式）。
 */
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
  // method === "x"
  for (const m of body.matchAll(/===\s*"([^"]+)"/g)) {
    covered.add(m[1]);
  }
  // ["a","b"].includes(method)
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
 * 用 TypeScript Compiler API 扫描 apps/desktop/src/main/ipc/ 下所有
 * ipcMain.handle("channel", callback) 注册点。
 *
 * 对每个回调 AST 节点递归检测：
 *  - 是否直接调用 sidecar.call(...) / sidecar.request(...)；
 *  - 是否调用 inspectTask(...)（e2e.ts 内部转发到 tasks.inspectState）。
 *
 * 分类口径（与 baseline 字段对齐）：
 *  - 生产非 test 通道：回调含 sidecar.call/request → forwarded，否则 local；
 *  - test.* 通道：回调含 sidecar.call/request 或 inspectTask 间接转发 → test_forwarded，
 *    否则 test_local。
 *
 * 别名转发（如 app.cleanupTemporaryData → storage.cleanupTemporary）在回调体内直接
 * 出现 sidecar.call，自然归 forwarded，无需特判。
 */
function extractIpcMainHandlers(): IpcMainRegistration[] {
  const out: IpcMainRegistration[] = [];
  for (const fn of MAIN_IPC_FILES) {
    const filePath = path.join(MAIN_IPC_DIR, fn);
    const text = readFileSync(filePath, "utf-8");
    const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, /*setParentNodes*/ true);
    const visit = (node: ts.Node) => {
      // 识别 ipcMain.handle("ch", callback) 表达式语句
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
            file: fn,
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

/** 在回调 AST 节点内递归检测 sidecar.call/request 与 inspectTask 调用。 */
function classifyCallback(root: ts.Node): { hasSidecarCall: boolean; hasInspectTask: boolean } {
  let hasSidecarCall = false;
  let hasInspectTask = false;
  const visit = (node: ts.Node) => {
    // sidecar.call(...) / sidecar.request(...)
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === "call" || node.expression.name.text === "request") &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "sidecar"
    ) {
      hasSidecarCall = true;
    }
    // inspectTask(...)（e2e.ts 内部转发到 tasks.inspectState）
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

describe("IPC 方法基线（Commit 1）— 五方集合锁定", () => {
  const baseline = loadBaseline();

  it("MethodNameSchema.options 与 baseline.method_name_schema 完全一致（43 项、无重复）", () => {
    const options = MethodNameSchema.options;
    expect(new Set(options).size, "MethodNameSchema 不应有重复项").toBe(options.length);
    expect(options.length).toBe(43);
    const { missing, extra } = diffSets(options, baseline.method_name_schema);
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it("TS sidecar.call/request 字面量调用集合与 baseline.typescript_engine_calls 完全一致（42 项）", () => {
    const { methods, dynamicHits } = extractTsEngineCalls(APPS_DESKTOP_SRC);
    // 动态变量入口：仅允许 SidecarManager 自身内部的 this.request(this,...) 转发。
    // 其他任何动态 method 变量都是回归风险，必须显式失败并报告 file:line。
    const allowedDynamic = dynamicHits.filter((h) =>
      /main\/sidecar\/manager\.(ts|tsx)$/.test(h.file.replace(/\\/g, "/")),
    );
    const disallowedDynamic = dynamicHits.filter(
      (h) => !/main\/sidecar\/manager\.(ts|tsx)$/.test(h.file.replace(/\\/g, "/")),
    );
    expect(
      disallowedDynamic,
      "发现非 SidecarManager 内部的动态 method 调用（应为字面量）",
    ).toEqual([]);
    // 即使是允许的内部转发，也记录其数量便于审计（当前预期为 1：manager.ts call→request）
    expect(allowedDynamic.length).toBe(1);

    // methods 来自字面量提取（带 Set 去重），数量校验即等价于无重复。
    expect(methods.size).toBe(42);
    const { missing, extra } = diffSets(methods, baseline.typescript_engine_calls);
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it("parseMethodResult 覆盖集合与 baseline.parse_method_result_covered 完全一致（28 项）", () => {
    const covered = extractParseMethodResultCovered(IPC_SCHEMA_PATH);
    expect(covered.size).toBe(28);
    const { missing, extra } = diffSets(covered, baseline.parse_method_result_covered);
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it("known_differences：每项 resolve_in_commit 合法（1-5 整数），id 唯一", () => {
    const ids = new Set<string>();
    for (const d of baseline.known_differences) {
      expect(Number.isInteger(d.resolve_in_commit), `非法 resolve_in_commit: ${d.id}`).toBe(true);
      expect(d.resolve_in_commit, `resolve_in_commit 应在 1-5: ${d.id}`).toBeGreaterThanOrEqual(1);
      expect(d.resolve_in_commit, `resolve_in_commit 应在 1-5: ${d.id}`).toBeLessThanOrEqual(5);
      expect(d.id.length, `id 不能为空`).toBeGreaterThan(0);
      expect(ids.has(d.id), `重复的 known_differences id: ${d.id}`).toBe(false);
      ids.add(d.id);
      const validKinds = ["schema_only_vs_python", "python_only_vs_schema", "engine_methods_missing_parser"];
      expect(validKinds, `未知差异类型应被测试定义`).toContain(d.kind);
    }
  });

  it("known_differences 反向完整性：五方真实差异必须被完整建模", () => {
    // 1. schema_only_vs_python：在 method_name_schema 但不在 python_handlers（也不应是 TS 调用的 Engine 方法）
    const schemaSet = new Set(baseline.method_name_schema);
    const pythonSet = new Set(baseline.python_handlers);
    const tsCallSet = new Set(baseline.typescript_engine_calls);
    const realSchemaOnlyVsPython = sorted(
      [...schemaSet].filter((m) => !pythonSet.has(m)),
    );
    // 2. python_only_vs_schema：在 python_handlers 但不在 method_name_schema
    const realPythonOnlyVsSchema = sorted(
      [...pythonSet].filter((m) => !schemaSet.has(m)),
    );
    // 3. engine_methods_missing_parser：真实 Engine 方法（= python_handlers，因 TS 调用集 ⊆ python）
    //    减去 parseMethodResult 覆盖集
    const coveredSet = new Set(baseline.parse_method_result_covered);
    // 真实 Engine 方法集合 = python_handlers（42）；TS 调用集应完全等于该集合
    expect(tsCallSet, "TS 调用集应等于 Python handler 集").toEqual(pythonSet);
    const realMissingParser = sorted(
      [...pythonSet].filter((m) => !coveredSet.has(m)),
    );

    // 从 baseline.known_differences 中按 kind 聚合被建模的方法
    const modeledSchemaOnly = new Set<string>();
    const modeledPythonOnly = new Set<string>();
    const modeledMissingParser = new Set<string>();
    for (const d of baseline.known_differences) {
      if (d.kind === "schema_only_vs_python") modeledSchemaOnly.add(d.item);
      else if (d.kind === "python_only_vs_schema") modeledPythonOnly.add(d.item);
      else if (d.kind === "engine_methods_missing_parser") {
        expect(d.methods, `${d.id} 应提供 methods 列表`).toBeDefined();
        for (const mth of d.methods ?? []) modeledMissingParser.add(mth);
      }
    }

    // 比对：真实差异与建模差异必须完全一致
    const schemaOnlyModeling = diffSets(realSchemaOnlyVsPython, [...modeledSchemaOnly]);
    expect(
      schemaOnlyModeling,
      `schema_only_vs_python 漂移建模不一致\n` +
        `  Missing in known_differences: ${schemaOnlyModeling.missing.join(", ") || "(无)"}\n` +
        `  Unexpected known difference: ${schemaOnlyModeling.extra.join(", ") || "(无)"}`,
    ).toEqual({ missing: [], extra: [] });

    const pythonOnlyModeling = diffSets(realPythonOnlyVsSchema, [...modeledPythonOnly]);
    expect(
      pythonOnlyModeling,
      `python_only_vs_schema 漂移建模不一致\n` +
        `  Missing in known_differences: ${pythonOnlyModeling.missing.join(", ") || "(无)"}\n` +
        `  Unexpected known difference: ${pythonOnlyModeling.extra.join(", ") || "(无)"}`,
    ).toEqual({ missing: [], extra: [] });

    const missingParserModeling = diffSets(realMissingParser, [...modeledMissingParser]);
    expect(
      missingParserModeling,
      `engine_methods_missing_parser 漂移建模不一致\n` +
        `  Missing parser coverage: ${missingParserModeling.missing.join(", ") || "(无)"}\n` +
        `  Unexpected parser gap: ${missingParserModeling.extra.join(", ") || "(无)"}`,
    ).toEqual({ missing: [], extra: [] });

    // parser fail-open 缺口数量必须精确为 14（Commit 3 将全部补齐）
    expect(
      realMissingParser.length,
      `缺 parser 的 Engine 方法数量应精确为 14，实际: ${realMissingParser.length}`,
    ).toBe(14);
  });

  it("baseline 所有数组无重复项（去重不变量）", () => {
    // 对 baseline 的所有数组字段逐项断言 new Set(values).size === values.length，
    // 防止后续编辑在数组中引入重复项而集合比对仍误判通过。
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
      const unique = new Set(values).size;
      expect(unique, `baseline.${key} 不应有重复项`).toBe(values.length);
    }
  });

  it("Electron 通道与真实源码 ipcMain.handle 注册完全一致（AST 扫描）", () => {
    // 用 TypeScript Compiler API 扫描 apps/desktop/src/main/ipc/ 下所有
    // ipcMain.handle("channel", callback) 注册点，按回调 AST 分类，再与 baseline 比对。
    // 这能在「新增/删除/重分类真实通道但忘记更新 baseline」时立即失败。
    const registrations = extractIpcMainHandlers();

    // 源码通道总数 = baseline 四类之和
    const baselineTotal =
      baseline.electron_local_channels.length +
      baseline.electron_forwarded_channels.length +
      baseline.electron_test_local_channels.length +
      baseline.electron_test_forwarded_channels.length;
    expect(registrations.length, "真实 ipcMain.handle 注册总数应与 baseline 一致").toBe(baselineTotal);

    // 源码通道不应有重复注册（同名 channel 注册两次属于回归风险）
    const sourceChannels = registrations.map((r) => r.channel);
    const sourceDupes = sorted(sourceChannels.filter((c, i) => sourceChannels.indexOf(c) !== i));
    expect(sourceDupes, "源码中不应有重复注册的 ipcMain.handle channel").toEqual([]);

    // 按回调分类口径分桶
    const classified = {
      local: new Set<string>(),
      forwarded: new Set<string>(),
      test_local: new Set<string>(),
      test_forwarded: new Set<string>(),
    };
    for (const r of registrations) {
      const isTest = r.channel.startsWith("test.");
      let bucket: keyof typeof classified;
      if (isTest) {
        // test 通道：含 sidecar.call/request 或 inspectTask 间接转发 → test_forwarded
        bucket = r.hasSidecarCall || r.hasInspectTask ? "test_forwarded" : "test_local";
      } else {
        // 生产通道：回调直接含 sidecar.call/request → forwarded，否则 local
        bucket = r.hasSidecarCall ? "forwarded" : "local";
      }
      classified[bucket].add(r.channel);
    }

    // baseline 各桶数量
    expect(classified.local.size, "electron_local 数量应为 17").toBe(17);
    expect(classified.forwarded.size, "electron_forwarded 数量应为 41").toBe(41);
    expect(classified.test_local.size, "electron_test_local 数量应为 8").toBe(8);
    expect(classified.test_forwarded.size, "electron_test_forwarded 数量应为 5").toBe(5);

    // 生产通道（local ∪ forwarded）与 baseline 完全一致，数量 58
    const prodModeling = diffSets(
      [...classified.local, ...classified.forwarded],
      [...baseline.electron_local_channels, ...baseline.electron_forwarded_channels],
    );
    expect(
      prodModeling,
      "生产 ipcMain.handle 通道（local ∪ forwarded）与 baseline 不一致\n" +
        `  Missing in baseline: ${prodModeling.missing.join(", ") || "(无)"}\n` +
        `  Unexpected in baseline: ${prodModeling.extra.join(", ") || "(无)"}`,
    ).toEqual({ missing: [], extra: [] });

    // E2E 通道（test_local ∪ test_forwarded）与 baseline 完全一致，数量 13
    const testModeling = diffSets(
      [...classified.test_local, ...classified.test_forwarded],
      [...baseline.electron_test_local_channels, ...baseline.electron_test_forwarded_channels],
    );
    expect(
      testModeling,
      "E2E ipcMain.handle 通道（test_local ∪ test_forwarded）与 baseline 不一致\n" +
        `  Missing in baseline: ${testModeling.missing.join(", ") || "(无)"}\n` +
        `  Unexpected in baseline: ${testModeling.extra.join(", ") || "(无)"}`,
    ).toEqual({ missing: [], extra: [] });

    // 分桶精确比对：local / forwarded / test_local / test_forwarded 各自一致
    const bucketPairs: Array<[Set<string>, string[], string]> = [
      [classified.local, baseline.electron_local_channels, "local"],
      [classified.forwarded, baseline.electron_forwarded_channels, "forwarded"],
      [classified.test_local, baseline.electron_test_local_channels, "test_local"],
      [classified.test_forwarded, baseline.electron_test_forwarded_channels, "test_forwarded"],
    ];
    for (const [actual, expected, name] of bucketPairs) {
      const d = diffSets(actual, expected);
      expect(
        d,
        `分桶 ${name} 与 baseline 不一致\n` +
          `  Missing in baseline: ${d.missing.join(", ") || "(无)"}\n` +
          `  Unexpected in baseline: ${d.extra.join(", ") || "(无)"}`,
      ).toEqual({ missing: [], extra: [] });
    }

    // 边界：electron_local 与 test_local 不应是 Engine 方法（local 在 Main 内完成）
    const pythonSet = new Set(baseline.python_handlers);
    const localCollide = sorted(
      [...classified.local, ...classified.test_local].filter((c) => pythonSet.has(c)),
    );
    expect(
      localCollide,
      "electron_local ∪ electron_test_local 不应是 Engine 方法",
    ).toEqual([]);
  });
});
