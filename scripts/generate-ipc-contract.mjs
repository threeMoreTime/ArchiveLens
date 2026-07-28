// ArchiveLens IPC 契约代码生成器（P1-8 Commit 2）。
//
// 输入：
//   contracts/engine-methods.json
//   contracts/electron-channels.json
// 输出：
//   packages/ipc-schema/src/generated/engineMethods.generated.ts
//
// 用法：
//   node scripts/generate-ipc-contract.mjs          生成（写入磁盘）
//   node scripts/generate-ipc-contract.mjs --check  仅比对，不写盘，不一致 exit 1
//
// 设计要点：
//   - 不依赖任何 npm 包，仅用 Node 内置 fs/path；
//   - 输出稳定：字典序、UTF-8 无 BOM、强制 \n、单一尾随换行、无时间戳；
//   - 生成器对两份 JSON 做完整结构校验，错误消息明确指出文件/字段/条目/非法值；
//   - 不暴露 python_handler 到生成的 TypeScript 生产 API。

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");
const ENGINE_CONTRACT = path.join(REPO_ROOT, "contracts", "engine-methods.json");
const ELECTRON_CONTRACT = path.join(REPO_ROOT, "contracts", "electron-channels.json");
const OUTPUT = path.join(REPO_ROOT, "packages", "ipc-schema", "src", "generated", "engineMethods.generated.ts");

const EXPECTED_PROTOCOL_VERSION = 4;
const EXPECTED_ENGINE_TOTAL = 42;
const EXPECTED_VISIBILITY = { engine_public: 38, engine_internal: 3, engine_test: 1 };
const EXPECTED_CHANNEL_TOTAL = 71;
const EXPECTED_CHANNEL_KINDS = {
  electron_local: 17,
  electron_forwarded: 41,
  electron_test_local: 8,
  electron_test_forwarded: 5,
};
const VALID_VISIBILITY = new Set(["engine_public", "engine_internal", "engine_test"]);
const VALID_PARAM_KINDS = new Set(["empty_object", "record", "schema"]);
const VALID_RESULT_KINDS = new Set(["schema", "empty_object"]);
const VALID_CHANNEL_KINDS = new Set([
  "electron_local",
  "electron_forwarded",
  "electron_test_local",
  "electron_test_forwarded",
]);

class ContractError extends Error {
  constructor(file, field, item, value, reason) {
    super(`${file} | ${field}${item ? ` (${item})` : ""}${value !== undefined ? ` = ${JSON.stringify(value)}` : ""}: ${reason}`);
    this.name = "ContractError";
  }
}

function readJson(filePath) {
  if (!existsSync(filePath)) {
    throw new ContractError(path.relative(REPO_ROOT, filePath), "file", "", undefined, "文件不存在");
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (error) {
    throw new ContractError(path.relative(REPO_ROOT, filePath), "json", "", undefined, `解析失败: ${error.message}`);
  }
  return parsed;
}

function validateEngineContract(data) {
  const file = "contracts/engine-methods.json";
  if (typeof data.schema_version !== "number" || data.schema_version < 1) {
    throw new ContractError(file, "schema_version", "", data.schema_version, "必须为正整数");
  }
  if (data.protocol_version !== EXPECTED_PROTOCOL_VERSION) {
    throw new ContractError(file, "protocol_version", "", data.protocol_version, `必须为 ${EXPECTED_PROTOCOL_VERSION}`);
  }
  const methods = data.engine_methods;
  if (!Array.isArray(methods)) {
    throw new ContractError(file, "engine_methods", "", "", "必须是数组");
  }
  if (methods.length !== EXPECTED_ENGINE_TOTAL) {
    throw new ContractError(file, "engine_methods", "", methods.length, `方法数量必须为 ${EXPECTED_ENGINE_TOTAL}`);
  }

  const seenMethods = new Map(); // method -> index
  const seenHandlers = new Map(); // python_handler -> method
  const visCounts = { engine_public: 0, engine_internal: 0, engine_test: 0 };
  const paramSchemaIds = new Set();
  const resultSchemaIds = new Set();

  // 先按字典序检查
  const sortedMethods = [...methods].map((m) => m.method).sort();
  for (let i = 0; i < methods.length; i++) {
    const m = methods[i];
    if (typeof m.method !== "string" || m.method.length === 0) {
      throw new ContractError(file, "method", `#${i + 1}`, m.method, "必须为非空字符串");
    }
    if (seenMethods.has(m.method)) {
      throw new ContractError(file, "method", m.method, "", `重复声明（首次出现在 #${seenMethods.get(m.method) + 1}）`);
    }
    seenMethods.set(m.method, i);

    if (!VALID_VISIBILITY.has(m.visibility)) {
      throw new ContractError(file, "visibility", m.method, m.visibility, "未知 visibility，合法值: engine_public/engine_internal/engine_test");
    }
    visCounts[m.visibility] += 1;

    if (typeof m.python_handler !== "string" || m.python_handler.length === 0) {
      throw new ContractError(file, "python_handler", m.method, m.python_handler, "必须为非空字符串");
    }
    if (seenHandlers.has(m.python_handler)) {
      throw new ContractError(file, "python_handler", m.method, m.python_handler, `重复（已用于 ${seenHandlers.get(m.python_handler)}）`);
    }
    seenHandlers.set(m.python_handler, m.method);

    const params = m.params;
    if (!params || typeof params !== "object") {
      throw new ContractError(file, "params", m.method, params, "必须为对象");
    }
    if (!VALID_PARAM_KINDS.has(params.kind)) {
      throw new ContractError(file, "params.kind", m.method, params.kind, "未知 params.kind，合法值: empty_object/record/schema");
    }
    if (params.kind === "schema") {
      if (typeof params.schema_id !== "string" || params.schema_id.length === 0) {
        throw new ContractError(file, "params.schema_id", m.method, params.schema_id, "params.kind=schema 时必须提供非空 schema_id");
      }
      paramSchemaIds.add(params.schema_id);
    } else if (params.schema_id !== undefined) {
      throw new ContractError(file, "params.schema_id", m.method, params.schema_id, `params.kind=${params.kind} 时禁止携带 schema_id`);
    }

    const result = m.result;
    if (!result || typeof result !== "object") {
      throw new ContractError(file, "result", m.method, result, "必须为对象");
    }
    if (!VALID_RESULT_KINDS.has(result.kind)) {
      throw new ContractError(file, "result.kind", m.method, result.kind, "未知 result.kind，合法值: schema/empty_object");
    }
    if (result.kind === "schema") {
      if (typeof result.schema_id !== "string" || result.schema_id.length === 0) {
        throw new ContractError(file, "result.schema_id", m.method, result.schema_id, "result.kind=schema 时必须提供非空 schema_id");
      }
      resultSchemaIds.add(result.schema_id);
    } else if (result.schema_id !== undefined) {
      throw new ContractError(file, "result.schema_id", m.method, result.schema_id, `result.kind=${result.kind} 时禁止携带 schema_id`);
    }
  }

  // 字典序校验
  const inOrder = methods.map((m) => m.method);
  for (let i = 1; i < inOrder.length; i++) {
    if (inOrder[i - 1] > inOrder[i]) {
      throw new ContractError(file, "engine_methods", inOrder[i], "", `方法未按字典序：${inOrder[i - 1]} 应排在 ${inOrder[i]} 之后`);
    }
  }

  // visibility 数量校验
  for (const [v, expected] of Object.entries(EXPECTED_VISIBILITY)) {
    if (visCounts[v] !== expected) {
      throw new ContractError(file, "visibility", v, visCounts[v], `数量必须为 ${expected}`);
    }
  }

  return {
    methods,
    paramSchemaIds: [...paramSchemaIds].sort(),
    resultSchemaIds: [...resultSchemaIds].sort(),
  };
}

function validateElectronContract(data, engineMethods) {
  const file = "contracts/electron-channels.json";
  if (typeof data.schema_version !== "number" || data.schema_version < 1) {
    throw new ContractError(file, "schema_version", "", data.schema_version, "必须为正整数");
  }
  const channels = data.channels;
  if (!Array.isArray(channels)) {
    throw new ContractError(file, "channels", "", "", "必须是数组");
  }
  if (channels.length !== EXPECTED_CHANNEL_TOTAL) {
    throw new ContractError(file, "channels", "", channels.length, `通道数量必须为 ${EXPECTED_CHANNEL_TOTAL}`);
  }

  const engineMethodSet = new Set(engineMethods.map((m) => m.method));
  const seenChannels = new Map();
  const kindCounts = {
    electron_local: 0,
    electron_forwarded: 0,
    electron_test_local: 0,
    electron_test_forwarded: 0,
  };

  for (let i = 0; i < channels.length; i++) {
    const c = channels[i];
    if (typeof c.channel !== "string" || c.channel.length === 0) {
      throw new ContractError(file, "channel", `#${i + 1}`, c.channel, "必须为非空字符串");
    }
    if (seenChannels.has(c.channel)) {
      throw new ContractError(file, "channel", c.channel, "", `重复声明（首次出现在 #${seenChannels.get(c.channel) + 1}）`);
    }
    seenChannels.set(c.channel, i);

    if (!VALID_CHANNEL_KINDS.has(c.kind)) {
      throw new ContractError(file, "kind", c.channel, c.kind, "未知 kind，合法值: electron_local/electron_forwarded/electron_test_local/electron_test_forwarded");
    }
    kindCounts[c.kind] += 1;

    const isTest = c.channel.startsWith("test.");
    const isTestKind = c.kind.startsWith("electron_test_");
    if (isTest && !isTestKind) {
      throw new ContractError(file, "kind", c.channel, c.kind, "test. 前缀通道必须使用 electron_test_* kind");
    }
    if (!isTest && isTestKind) {
      throw new ContractError(file, "kind", c.channel, c.kind, "production 通道不得使用 electron_test_* kind");
    }

    const isForwarded = c.kind === "electron_forwarded" || c.kind === "electron_test_forwarded";
    const isLocal = c.kind === "electron_local" || c.kind === "electron_test_local";
    if (isForwarded) {
      if (typeof c.engine_method !== "string" || c.engine_method.length === 0) {
        throw new ContractError(file, "engine_method", c.channel, c.engine_method, "forwarded kind 必须提供 engine_method");
      }
      if (!engineMethodSet.has(c.engine_method)) {
        throw new ContractError(file, "engine_method", c.channel, c.engine_method, "引用的 Engine 方法不存在于 engine-methods.json");
      }
    } else if (isLocal) {
      if (c.engine_method !== undefined) {
        throw new ContractError(file, "engine_method", c.channel, c.engine_method, "local kind 禁止携带 engine_method");
      }
    }

    // 暴露字段冲突：production 通道用 preload_exposed，test 通道用 preload_exposed_in_e2e_only
    const hasProd = c.preload_exposed === true;
    const hasTest = c.preload_exposed_in_e2e_only === true;
    if (hasProd && hasTest) {
      throw new ContractError(file, "preload_exposed", c.channel, "", "preload_exposed 与 preload_exposed_in_e2e_only 不得同时为 true");
    }
    if (isTestKind && hasProd) {
      throw new ContractError(file, "preload_exposed", c.channel, c.preload_exposed, "test 通道应使用 preload_exposed_in_e2e_only");
    }
    if (!isTestKind && hasTest) {
      throw new ContractError(file, "preload_exposed_in_e2e_only", c.channel, c.preload_exposed_in_e2e_only, "production 通道应使用 preload_exposed");
    }
  }

  // 字典序校验
  const inOrder = channels.map((c) => c.channel);
  for (let i = 1; i < inOrder.length; i++) {
    if (inOrder[i - 1] > inOrder[i]) {
      throw new ContractError(file, "channels", inOrder[i], "", `通道未按字典序：${inOrder[i - 1]} 应排在 ${inOrder[i]} 之后`);
    }
  }

  // kind 数量校验
  for (const [k, expected] of Object.entries(EXPECTED_CHANNEL_KINDS)) {
    if (kindCounts[k] !== expected) {
      throw new ContractError(file, "kind", k, kindCounts[k], `数量必须为 ${expected}`);
    }
  }
}

function generateTypeScript(engine) {
  const lines = [];
  lines.push("// AUTO-GENERATED from contracts/engine-methods.json — DO NOT EDIT.");
  lines.push("// 由 scripts/generate-ipc-contract.mjs 生成。修改请编辑契约 JSON 后重新生成。");
  lines.push("");

  const allMethods = engine.methods.map((m) => m.method);
  const publicMethods = engine.methods.filter((m) => m.visibility === "engine_public").map((m) => m.method);
  const internalMethods = engine.methods.filter((m) => m.visibility === "engine_internal").map((m) => m.method);
  const testMethods = engine.methods.filter((m) => m.visibility === "engine_test").map((m) => m.method);

  const emit = (name, values, doc) => {
    lines.push(`/** ${doc}（${values.length} 项）。 */`);
    lines.push(`export const ${name} = [`);
    for (const v of values) {
      lines.push(`  ${JSON.stringify(v)},`);
    }
    lines.push(`] as const;`);
    lines.push("");
  };

  emit("ENGINE_METHOD_NAMES", allMethods, "全部 Engine 方法名（字典序）");
  emit("ENGINE_PUBLIC_METHOD_NAMES", publicMethods, "生产可调用的 Engine 方法");
  emit("ENGINE_INTERNAL_METHOD_NAMES", internalMethods, "Engine 生命周期/进程/诊断方法（仅 Main 受控调用）");
  emit("ENGINE_TEST_METHOD_NAMES", testMethods, "仅 E2E 测试使用的 Engine 方法");
  emit("ENGINE_PARAM_SCHEMA_IDS", engine.paramSchemaIds, "参数 schema 语义 ID（params.kind=schema 引用）");
  emit("ENGINE_RESULT_SCHEMA_IDS", engine.resultSchemaIds, "结果 schema 语义 ID（result.kind=schema 引用）");

  // ENGINE_METHOD_RESULT_CONTRACT：method → { kind, schemaId? } 映射，
  // 由契约 result 字段直接派生。parseMethodResult 的 parser 通过此映射
  // 从 RESULT_SCHEMA_REGISTRY 取 schema，禁止在 index.ts 手写第二份映射。
  lines.push("/** 每个 Engine 方法的结果契约（由 engine-methods.json result 字段派生）。 */");
  lines.push("export const ENGINE_METHOD_RESULT_CONTRACT = {");
  for (const m of engine.methods) {
    const r = m.result;
    if (r.kind === "schema") {
      lines.push(`  ${JSON.stringify(m.method)}: { kind: "schema", schemaId: ${JSON.stringify(r.schema_id)} },`);
    } else if (r.kind === "empty_object") {
      lines.push(`  ${JSON.stringify(m.method)}: { kind: "empty_object" },`);
    } else {
      // 生成器已校验 result.kind 合法，此处不可达；保留以防御未来扩展。
      throw new Error(`未处理的 result.kind: ${r.kind} (method=${m.method})`);
    }
  }
  lines.push("} as const;");
  lines.push("");

  lines.push("export type EngineMethodName = typeof ENGINE_METHOD_NAMES[number];");
  lines.push("export type EnginePublicMethodName = typeof ENGINE_PUBLIC_METHOD_NAMES[number];");
  lines.push("export type EngineInternalMethodName = typeof ENGINE_INTERNAL_METHOD_NAMES[number];");
  lines.push("export type EngineTestMethodName = typeof ENGINE_TEST_METHOD_NAMES[number];");
  lines.push("export type EngineParamSchemaId = typeof ENGINE_PARAM_SCHEMA_IDS[number];");
  lines.push("export type EngineResultSchemaId = typeof ENGINE_RESULT_SCHEMA_IDS[number];");
  lines.push("export type EngineMethodResultContract = typeof ENGINE_METHOD_RESULT_CONTRACT;");
  lines.push("export type EngineMethodResultKind = EngineMethodResultContract[EngineMethodName][\"kind\"];");
  lines.push("");
  lines.push("export type EngineMethodVisibility =");
  lines.push('  | "engine_public"');
  lines.push('  | "engine_internal"');
  lines.push('  | "engine_test";');
  lines.push("");

  return lines.join("\n");
}

function main() {
  const args = process.argv.slice(2);
  let checkMode = false;
  for (const a of args) {
    if (a === "--check") {
      checkMode = true;
    } else {
      console.error(`未知参数: ${a}`);
      console.error("用法: node scripts/generate-ipc-contract.mjs [--check]");
      process.exit(2);
    }
  }

  let engine, electron;
  try {
    engine = validateEngineContract(readJson(ENGINE_CONTRACT));
    validateElectronContract(readJson(ELECTRON_CONTRACT), engine.methods);
  } catch (error) {
    if (error instanceof ContractError) {
      console.error(`[ipc-contract] 校验失败: ${error.message}`);
    } else {
      console.error(`[ipc-contract] 异常: ${error.stack}`);
    }
    process.exit(1);
  }

  const generated = generateTypeScript(engine);

  if (checkMode) {
    let onDisk = "";
    if (existsSync(OUTPUT)) {
      onDisk = readFileSync(OUTPUT, "utf-8");
    }
    if (onDisk !== generated) {
      console.error(`[ipc-contract] 生成文件与磁盘不一致: ${path.relative(REPO_ROOT, OUTPUT)}`);
      console.error("[ipc-contract] 修复命令: node scripts/generate-ipc-contract.mjs");
      process.exit(1);
    }
    console.error(`[ipc-contract] --check 通过: ${path.relative(REPO_ROOT, OUTPUT)} 已是最新（42 方法，38/3/1 分类）。`);
    return;
  }

  // 原子写入：先写临时文件，再 rename。
  const outputDir = path.dirname(OUTPUT);
  mkdirSync(outputDir, { recursive: true });
  const tmpPath = OUTPUT + ".tmp";
  writeFileSync(tmpPath, generated, { encoding: "utf-8" });
  renameSync(tmpPath, OUTPUT);
  console.error(`[ipc-contract] 已生成: ${path.relative(REPO_ROOT, OUTPUT)}（42 方法，38/3/1 分类）。`);
}

main();
