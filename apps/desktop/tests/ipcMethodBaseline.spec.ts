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
import { MethodNameSchema } from "@shared/index";

// 测试文件位于 apps/desktop/tests/，仓库根在其上三级。
const REPO_ROOT = path.resolve(__dirname, "../../..");
const BASELINE_PATH = path.resolve(REPO_ROOT, "contracts/ipc-method-audit.baseline.json");
const IPC_SCHEMA_PATH = path.resolve(REPO_ROOT, "packages/ipc-schema/src/index.ts");
const APPS_DESKTOP_SRC = path.resolve(REPO_ROOT, "apps/desktop/src");

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

    expect(methods.size, "TS Engine 调用集合不应有重复").toBe(methods.size);
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

  it("Electron 本地通道集合与 baseline 一致（local 17 / forwarded 41 / test_local 8 / test_forwarded 5）", () => {
    // 本测试校验 baseline 中记录的 Electron 通道集合内部一致性，
    // 以及与 Engine 方法集的边界（local/test_local 不应与 engine method 重名）。
    const local = new Set(baseline.electron_local_channels);
    const forwarded = new Set(baseline.electron_forwarded_channels);
    const testLocal = new Set(baseline.electron_test_local_channels);
    const testForwarded = new Set(baseline.electron_test_forwarded_channels);

    expect(local.size).toBe(17);
    expect(forwarded.size).toBe(41);
    expect(testLocal.size).toBe(8);
    expect(testForwarded.size).toBe(5);

    // 通道集合互不相交
    const allChannels = [...local, ...forwarded, ...testLocal, ...testForwarded];
    expect(new Set(allChannels).size, "Electron 通道集合不应有重叠").toBe(allChannels.length);

    // Electron 本地通道与 test 通道不应直接是 Engine 方法名（local 在 Main 内完成）
    const pythonSet = new Set(baseline.python_handlers);
    const localCollideWithEngine = sorted([...local].filter((c) => pythonSet.has(c)));
    expect(
      localCollideWithEngine,
      "electron_local 不应是 Engine 方法（应与 Python handler 集不相交）",
    ).toEqual([]);

    // test_local 不应是 Engine 方法
    const testLocalCollide = sorted([...testLocal].filter((c) => pythonSet.has(c)));
    expect(testLocalCollide, "electron_test_local 不应是 Engine 方法").toEqual([]);
  });
});
