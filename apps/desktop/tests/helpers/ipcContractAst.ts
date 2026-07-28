/**
 * P1-8 Commit 4/4.1 — IPC 契约 AST helper。
 *
 * 全部基于 TypeScript Compiler API（不再用逐行正则），识别：
 *   1. 全仓 sidecar.call/request 字面量与动态 method（含 this.call 内部转发）；
 *   2. Main 的 ipcMain.handle 注册（含动态/缺失 channel）；
 *   3. Preload 的 ipcRenderer.invoke 调用与 E2E 分支归属。
 *
 * 设计为可接受任意 source text + path 的纯解析函数（parseEngineCallsFromSource 等），
 * 便于变异测试用临时 fixture 验证，不修改真实仓库源码。
 *
 * 不扫描 *.d.ts、node_modules、out、dist、tests、.git。
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

/** 动态 Engine method 调用的精确位置。 */
export interface DynamicEngineCall {
  file: string;
  line: number;
  column: number;
  /** 接收者表达式文本（sidecar / this / 其他）。 */
  receiver: string;
  /** 调用方法名（call / request）。 */
  method: string;
  /** 包含该调用的类名（若有）。 */
  enclosingClass: string | null;
  /** 包含该调用的方法/函数名（若有）。 */
  enclosingMethod: string | null;
}

/** 字面量 Engine method 调用记录。 */
export interface LiteralEngineCall {
  method: string;
  file: string;
  line: number;
  /** 接收者：sidecar / this。 */
  receiver: "sidecar" | "this";
}

/** 全仓 sidecar 调用扫描结果。 */
export interface EngineCallScan {
  /** 所有字面量 method 名（去重）。 */
  methods: Set<string>;
  /** 字面量调用明细（含位置）。 */
  literals: LiteralEngineCall[];
  /** 动态 method 调用明细（含位置）。 */
  dynamicHits: DynamicEngineCall[];
}

/** 解析单个源文件的 Engine 调用（纯函数，可被变异测试复用）。 */
export function parseEngineCallsFromSource(
  sourceText: string,
  filePath: string,
): { literals: LiteralEngineCall[]; dynamicHits: DynamicEngineCall[] } {
  const sf = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, /*setParentNodes*/ true);
  const fileName = path.basename(filePath);
  const literals: LiteralEngineCall[] = [];
  const dynamicHits: DynamicEngineCall[] = [];

  // 预计算每个节点的 enclosing class/method（向上遍历父链）。
  const enclosingOf = (node: ts.Node): { cls: string | null; method: string | null } => {
    let cls: string | null = null;
    let method: string | null = null;
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (!method && ts.isMethodDeclaration(current) && current.name && ts.isIdentifier(current.name)) {
        method = current.name.text;
      }
      if (!cls && ts.isClassDeclaration(current) && current.name) {
        cls = current.name.text;
      }
      current = current.parent;
    }
    return { cls, method };
  };

  const receiverText = (expr: ts.Expression): "sidecar" | "this" | null => {
    // sidecar.call / sidecar.request
    if (ts.isIdentifier(expr) && expr.text === "sidecar") return "sidecar";
    // this.call / this.request（SidecarManager 内部）
    if (expr.kind === ts.SyntaxKind.ThisKeyword) return "this";
    return null;
  };

  const visit = (node: ts.Node) => {
    // 识别 <receiver>.call(...) / <receiver>.request(...)
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === "call" || node.expression.name.text === "request")
    ) {
      const recv = receiverText(node.expression.expression);
      if (recv) {
        const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        const first = node.arguments[0];
        const enc = enclosingOf(node);
        if (first && ts.isStringLiteral(first)) {
          literals.push({
            method: first.text,
            file: fileName,
            line: line + 1,
            receiver: recv,
          });
        } else {
          dynamicHits.push({
            file: fileName,
            line: line + 1,
            column: character + 1,
            receiver: recv,
            method: node.expression.name.text,
            enclosingClass: enc.cls,
            enclosingMethod: enc.method,
          });
        }
      }
      // 非 sidecar/this 的 .call/.request（如 foo.call、mock.request、api.call）忽略
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { literals, dynamicHits };
}

/**
 * 递归扫描 apps/desktop/src 下所有 .ts/.tsx 的 sidecar.call/request 字面量与动态 method。
 * 通过 AST 识别，正确处理多行、泛型、注释、字符串、非 Sidecar receiver。
 */
export function extractTsEngineCalls(srcRoot: string): EngineCallScan {
  const methods = new Set<string>();
  const literals: LiteralEngineCall[] = [];
  const dynamicHits: DynamicEngineCall[] = [];
  const files = collectSourceFiles(srcRoot);
  for (const file of files) {
    const text = readFileSync(file, "utf-8");
    const rel = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
    const result = parseEngineCallsFromSource(text, file);
    for (const lit of result.literals) {
      methods.add(lit.method);
      literals.push({ ...lit, file: rel });
    }
    for (const dyn of result.dynamicHits) {
      dynamicHits.push({ ...dyn, file: rel });
    }
  }
  return { methods, literals, dynamicHits };
}

/** Main handler 注册信息（Commit 4.1 增强版，记录动态/缺失 channel）。 */
export interface IpcMainRegistration {
  /** channel 名；动态或缺失时为 null。 */
  channel: string | null;
  /** channel 是否为字符串字面量。 */
  channelIsLiteral: boolean;
  file: string;
  line: number;
  column: number;
  /** 是否提供 callback 参数。 */
  callbackPresent: boolean;
  /** 回调内直接出现的 sidecar.call/request 字面量方法名。 */
  directEngineMethods: string[];
  /** 回调内动态 method 调用明细。 */
  dynamicEngineMethods: DynamicEngineCall[];
  /** 回调内直接调用 inspectTask 的次数。 */
  inspectTaskCallCount: number;
  /** 回调内是否出现 sidecar.call/request（用于分类 forwarded/local）。 */
  hasSidecarCall: boolean;
  /** 回调内是否调用 inspectTask（test.task.* 间接转发）。 */
  hasInspectTask: boolean;
}

/** 解析单个源文件的 ipcMain.handle 注册（纯函数）。 */
export function parseIpcMainHandlersFromSource(
  sourceText: string,
  filePath: string,
): IpcMainRegistration[] {
  const sf = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, /*setParentNodes*/ true);
  const fileName = path.basename(filePath);
  const out: IpcMainRegistration[] = [];

  const analyzeCallback = (cb: ts.Node): {
    direct: string[];
    dynamic: DynamicEngineCall[];
    inspectCount: number;
    hasSidecar: boolean;
  } => {
    const direct: string[] = [];
    const dynamic: DynamicEngineCall[] = [];
    let inspectCount = 0;
    let hasSidecar = false;
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        (node.expression.name.text === "call" || node.expression.name.text === "request") &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "sidecar"
      ) {
        hasSidecar = true;
        const first = node.arguments[0];
        const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        if (first && ts.isStringLiteral(first)) {
          direct.push(first.text);
        } else {
          dynamic.push({
            file: fileName,
            line: line + 1,
            column: character + 1,
            receiver: "sidecar",
            method: node.expression.name.text,
            enclosingClass: null,
            enclosingMethod: null,
          });
        }
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "inspectTask"
      ) {
        inspectCount += 1;
      }
      ts.forEachChild(node, visit);
    };
    visit(cb);
    return { direct, dynamic, inspectCount, hasSidecar };
  };

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
      const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));

      let channel: string | null = null;
      let channelIsLiteral = false;
      if (channelArg && ts.isStringLiteral(channelArg)) {
        channel = channelArg.text;
        channelIsLiteral = true;
      }

      const callbackPresent = callbackArg !== undefined;
      const analyzed = callbackArg
        ? analyzeCallback(callbackArg)
        : { direct: [], dynamic: [], inspectCount: 0, hasSidecar: false };

      out.push({
        channel,
        channelIsLiteral,
        file: fileName,
        line: line + 1,
        column: character + 1,
        callbackPresent,
        directEngineMethods: analyzed.direct,
        dynamicEngineMethods: analyzed.dynamic,
        inspectTaskCallCount: analyzed.inspectCount,
        hasSidecarCall: analyzed.hasSidecar,
        hasInspectTask: analyzed.inspectCount > 0,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * 递归扫描 apps/desktop/src/main/ipc/ 下所有 .ts 文件，提取 ipcMain.handle 注册。
 * 记录所有调用（含动态/缺失 channel），不静默跳过任何注册。
 */
export function extractIpcMainHandlers(): IpcMainRegistration[] {
  const out: IpcMainRegistration[] = [];
  const files = collectSourceFiles(MAIN_IPC_DIR);
  for (const file of files) {
    const text = readFileSync(file, "utf-8");
    const rel = path.relative(MAIN_IPC_DIR, file).replace(/\\/g, "/");
    const result = parseIpcMainHandlersFromSource(text, file);
    for (const r of result) {
      out.push({ ...r, file: rel });
    }
  }
  return out;
}

/** Preload invoke 信息。 */
export interface PreloadInvoke {
  channel: string;
  /** 是否位于 ARCHIVELENS_E2E === "1" 分支内。 */
  inE2eBranch: boolean;
  /** invoke 实参是否为字符串字面量（动态变量记 false）。 */
  isLiteral: boolean;
}

/**
 * 解析 Preload 文件，提取所有 ipcRenderer.invoke("channel") 调用，
 * 并判断每个调用是否位于 `if (process.env["ARCHIVELENS_E2E"] === "1")` 分支内。
 * 不收集 ipcRenderer.on/off 订阅。
 */
export function extractPreloadInvokes(): PreloadInvoke[] {
  const out: PreloadInvoke[] = [];
  const text = readFileSync(PRELOAD_PATH, "utf-8");
  const sf = ts.createSourceFile(PRELOAD_PATH, text, ts.ScriptTarget.Latest, /*setParentNodes*/ true);

  const isInsideE2e = (node: ts.Node): boolean => {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (ts.isIfStatement(current)) {
        const cond = current.expression;
        const matchE2eEnv = (expr: ts.Node): boolean => {
          if (!ts.isBinaryExpression(expr)) return false;
          if (expr.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return false;
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
          const rightIsOne = (side: ts.Node): boolean =>
            ts.isStringLiteral(side) && side.text === "1";
          return (
            (isEnvAccess(expr.left) && rightIsOne(expr.right)) ||
            (isEnvAccess(expr.right) && rightIsOne(expr.left))
          );
        };
        if (matchE2eEnv(cond)) return true;
      }
      current = current.parent;
    }
    return false;
  };

  const visit = (node: ts.Node) => {
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
