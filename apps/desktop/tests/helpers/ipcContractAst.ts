/**
 * P1-8 Commit 4 — IPC 契约 AST helper。
 *
 * 提供两套基于 TypeScript Compiler API 的扫描器，供 ipcMethodBaseline.spec.ts
 * 与 ipcContractConsistency.spec.ts 共用，避免重复实现两套不同扫描器。
 *
 * 1. Main handler 扫描：递归发现 apps/desktop/src/main/ipc 下所有 .ts 文件中的
 *    ipcMain.handle("channel", callback) 注册，解析 callback 内的
 *    sidecar.call/request 字面量与 inspectTask 间接调用。
 * 2. Preload invoke 扫描：解析 apps/desktop/src/preload/index.ts 中的
 *    ipcRenderer.invoke("channel") 调用，并判断是否位于 ARCHIVELENS_E2E 分支内。
 *
 * 不扫描 *.d.ts、node_modules、out、dist、tests。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import * as ts from "typescript";

/** helper 位于 apps/desktop/tests/helpers/，仓库根在其上四级。 */
export const REPO_ROOT = path.resolve(__dirname, "../../../..");
export const APPS_DESKTOP_SRC = path.resolve(REPO_ROOT, "apps/desktop/src");
const MAIN_IPC_DIR = path.resolve(APPS_DESKTOP_SRC, "main/ipc");
const PRELOAD_PATH = path.resolve(APPS_DESKTOP_SRC, "preload/index.ts");

/** 排除目录（路径片段匹配）。 */
const EXCLUDED_DIR_FRAGMENTS = ["node_modules", "out", "dist", "tests", ".git"];

/** 递归收集目录下所有 .ts/.tsx 文件（忽略 .d.ts 与排除目录），路径排序稳定。 */
export function collectSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (EXCLUDED_DIR_FRAGMENTS.includes(entry)) continue;
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

/** Main handler 注册信息。 */
export interface IpcMainRegistration {
  channel: string;
  file: string;
  hasSidecarCall: boolean;
  hasInspectTask: boolean;
  /** 回调内直接出现的 sidecar.call/request 字面量方法名（用于精确映射核验）。 */
  directEngineMethods: string[];
  /** 回调内是否出现动态 method 变量（非字符串字面量）。 */
  hasDynamicMethod: boolean;
  /** 回调内直接调用 inspectTask 的次数。 */
  inspectTaskCallCount: number;
}

/** Preload invoke 信息。 */
export interface PreloadInvoke {
  channel: string;
  /** 是否位于 ARCHIVELENS_E2E === "1" 分支内。 */
  inE2eBranch: boolean;
  /** invoke 实参是否为字符串字面量（动态变量记 false）。 */
  isLiteral: boolean;
}

/** 在回调 AST 节点内递归收集 sidecar.call/request 与 inspectTask 调用信息。 */
function analyzeCallback(root: ts.Node): {
  hasSidecarCall: boolean;
  hasInspectTask: boolean;
  directEngineMethods: string[];
  hasDynamicMethod: boolean;
  inspectTaskCallCount: number;
} {
  let hasSidecarCall = false;
  let hasInspectTask = false;
  const directEngineMethods: string[] = [];
  let hasDynamicMethod = false;
  let inspectTaskCallCount = 0;

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
      const first = node.arguments[0];
      if (first && ts.isStringLiteral(first)) {
        directEngineMethods.push(first.text);
      } else {
        hasDynamicMethod = true;
      }
    }
    // inspectTask(...)（e2e.ts 内部转发到 tasks.inspectState）
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "inspectTask"
    ) {
      hasInspectTask = true;
      inspectTaskCallCount += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return { hasSidecarCall, hasInspectTask, directEngineMethods, hasDynamicMethod, inspectTaskCallCount };
}

/**
 * 递归扫描 apps/desktop/src/main/ipc/ 下所有 .ts 文件，提取 ipcMain.handle 注册。
 * 不使用固定文件清单，未来新增 IPC 文件自动纳入。
 */
export function extractIpcMainHandlers(): IpcMainRegistration[] {
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
          const a = analyzeCallback(callbackArg);
          out.push({
            channel: channelArg.text,
            file: path.relative(MAIN_IPC_DIR, file).replace(/\\/g, "/"),
            hasSidecarCall: a.hasSidecarCall,
            hasInspectTask: a.hasInspectTask,
            directEngineMethods: a.directEngineMethods,
            hasDynamicMethod: a.hasDynamicMethod,
            inspectTaskCallCount: a.inspectTaskCallCount,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

/**
 * 解析 Preload 文件，提取所有 ipcRenderer.invoke("channel") 调用，
 * 并判断每个调用是否位于 `if (process.env["ARCHIVELENS_E2E"] === "1")` 分支内。
 *
 * 不收集 ipcRenderer.on/off 订阅（它们不是 handle/invoke 通道）。
 */
export function extractPreloadInvokes(): PreloadInvoke[] {
  const out: PreloadInvoke[] = [];
  const text = readFileSync(PRELOAD_PATH, "utf-8");
  const sf = ts.createSourceFile(PRELOAD_PATH, text, ts.ScriptTarget.Latest, /*setParentNodes*/ true);

  // 判断某节点是否在 ARCHIVELENS_E2E 条件分支内（向上遍历父节点）。
  const isInsideE2e = (node: ts.Node): boolean => {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (ts.isIfStatement(current)) {
        const cond = current.expression;
        // 匹配 process.env["ARCHIVELENS_E2E"] === "1" 或 process.env.ARCHIVELENS_E2E === "1"
        const matchE2eEnv = (expr: ts.Node): boolean => {
          if (!ts.isBinaryExpression(expr)) return false;
          const isEq = expr.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken;
          if (!isEq) return false;
          const sideHasEnv = (side: ts.Node): boolean => {
            // process.env["ARCHIVELENS_E2E"] / process.env.ARCHIVELENS_E2E
            const isEnvAccess = (n: ts.Node): boolean => {
              if (
                ts.isElementAccessExpression(n) &&
                ts.isPropertyAccessExpression(n.expression) &&
                n.expression.name.text === "env" &&
                ts.isIdentifier(n.expression.expression) &&
                n.expression.expression.text === "process" &&
                ts.isStringLiteral(n.argumentExpression) &&
                n.argumentExpression.text === "ARCHIVELENS_E2E"
              ) {
                return true;
              }
              if (
                ts.isPropertyAccessExpression(n) &&
                n.name.text === "ARCHIVELENS_E2E" &&
                ts.isPropertyAccessExpression(n.expression) &&
                n.expression.name.text === "env" &&
                ts.isIdentifier(n.expression.expression) &&
                n.expression.expression.text === "process"
              ) {
                return true;
              }
              return false;
            };
            return isEnvAccess(side);
          };
          const rightIsOne = (side: ts.Node): boolean =>
            ts.isStringLiteral(side) && side.text === "1";
          return (sideHasEnv(expr.left) && rightIsOne(expr.right)) ||
            (sideHasEnv(expr.right) && rightIsOne(expr.left));
        };
        if (matchE2eEnv(cond)) return true;
      }
      current = current.parent;
    }
    return false;
  };

  const visit = (node: ts.Node) => {
    // ipcRenderer.invoke("channel", ...)
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "invoke" &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "ipcRenderer"
    ) {
      const first = node.arguments[0];
      if (first && ts.isStringLiteral(first)) {
        out.push({ channel: first.text, inE2eBranch: isInsideE2e(node), isLiteral: true });
      } else {
        out.push({ channel: "", inE2eBranch: isInsideE2e(node), isLiteral: false });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** 字符串集合差异，输出可读的 Missing/Unexpected。 */
export function diffSets(
  actual: Iterable<string>,
  expected: Iterable<string>,
): { missing: string[]; extra: string[] } {
  const a = new Set(actual);
  const e = new Set(expected);
  const missing = [...e].filter((x) => !a.has(x)).sort();
  const extra = [...a].filter((x) => !e.has(x)).sort();
  return { missing, extra };
}

export function sorted(arr: Iterable<string>): string[] {
  return [...arr].sort();
}

/**
 * 从 apps/desktop/src 扫描 sidecar.call(...) / sidecar.request(...) 的字面量方法名。
 * 仅接受字符串字面量实参；动态变量记入 dynamicHits。SidecarManager 自身内部
 * this.call / this.request 互相转发不算外部入口，但其字面量仍是真实 Engine 调用。
 */
export function extractTsEngineCalls(srcRoot: string): {
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
