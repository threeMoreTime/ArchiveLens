// ArchiveLens IPC 契约核心校验与代码生成模块（P1-8 Commit 4）。
//
// 从 generate-ipc-contract.mjs 拆分而来，提供可被 node:test 直接 import 的纯函数，
// 不包含任何文件 IO 或 CLI 逻辑。generate-ipc-contract.mjs 仅负责路径解析、磁盘读写、
// 原子写入与 --check 比对。
//
// 不依赖任何 npm 包。

export const EXPECTED_PROTOCOL_VERSION = 4;
export const EXPECTED_SCHEMA_VERSION = 1;
export const EXPECTED_ENGINE_TOTAL = 42;
export const EXPECTED_VISIBILITY = { engine_public: 38, engine_internal: 3, engine_test: 1 };
export const EXPECTED_CHANNEL_TOTAL = 71;
export const EXPECTED_CHANNEL_KINDS = {
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

// 顶层字段白名单：出现未知顶层字段时报错，防止拼写错误被静默忽略。
const ALLOWED_ENGINE_TOP_FIELDS = new Set(["schema_version", "protocol_version", "description", "engine_methods"]);
const ALLOWED_ELECTRON_TOP_FIELDS = new Set(["schema_version", "description", "channels"]);
const ALLOWED_METHOD_FIELDS = new Set(["method", "visibility", "params", "result", "python_handler"]);
const ALLOWED_PARAM_RESULT_FIELDS = new Set(["kind", "schema_id"]);
const ALLOWED_CHANNEL_FIELDS = new Set([
  "channel",
  "kind",
  "engine_method",
  "preload_exposed",
  "preload_exposed_in_e2e_only",
]);

export class ContractError extends Error {
  constructor(file, field, item, value, reason) {
    super(
      `${file} | ${field}${item ? ` (${item})` : ""}${
        value !== undefined ? ` = ${JSON.stringify(value)}` : ""
      }: ${reason}`,
    );
    this.name = "ContractError";
  }
}

/**
 * 校验 schema_version 严格等于 1 且为整数。
 * @param {unknown} value
 * @param {string} file
 */
function validateSchemaVersion(value, file) {
  if (value === undefined) {
    throw new ContractError(file, "schema_version", "", undefined, "字段缺失，必须为整数 1");
  }
  if (!Number.isInteger(value)) {
    throw new ContractError(
      file,
      "schema_version",
      "",
      value,
      `必须为整数 ${EXPECTED_SCHEMA_VERSION}（实际类型 ${typeof value}）`,
    );
  }
  if (value !== EXPECTED_SCHEMA_VERSION) {
    throw new ContractError(
      file,
      "schema_version",
      "",
      value,
      `必须为 ${EXPECTED_SCHEMA_VERSION}（预期 ${EXPECTED_SCHEMA_VERSION}）`,
    );
  }
}

/**
 * 断言对象不包含白名单外的字段。
 * @param {Record<string, unknown>} obj
 * @param {Set<string>} allowed
 * @param {string} file
 * @param {string} field
 * @param {string} item
 */
function rejectUnknownFields(obj, allowed, file, field, item) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new ContractError(file, `${field}.${key}`, item, obj[key], "未知字段，不在允许字段集合内");
    }
  }
}

/**
 * 校验 Engine 契约。返回归一化后的方法列表与 schema id 集合。
 * @param {unknown} data
 * @param {string} [fileLabel]
 * @returns {{ methods: any[], paramSchemaIds: string[], resultSchemaIds: string[] }}
 */
export function validateEngineContract(data, fileLabel = "contracts/engine-methods.json") {
  if (!data || typeof data !== "object") {
    throw new ContractError(fileLabel, "file", "", data, "根必须是对象");
  }
  validateSchemaVersion(data.schema_version, fileLabel);
  rejectUnknownFields(data, ALLOWED_ENGINE_TOP_FIELDS, fileLabel, "(顶层)", "");

  if (data.protocol_version !== EXPECTED_PROTOCOL_VERSION) {
    throw new ContractError(
      fileLabel,
      "protocol_version",
      "",
      data.protocol_version,
      `必须为 ${EXPECTED_PROTOCOL_VERSION}`,
    );
  }

  const methods = data.engine_methods;
  if (!Array.isArray(methods)) {
    throw new ContractError(fileLabel, "engine_methods", "", "", "必须是数组");
  }
  if (methods.length !== EXPECTED_ENGINE_TOTAL) {
    throw new ContractError(
      fileLabel,
      "engine_methods",
      "",
      methods.length,
      `方法数量必须为 ${EXPECTED_ENGINE_TOTAL}`,
    );
  }

  const seenMethods = new Map();
  const seenHandlers = new Map();
  const visCounts = { engine_public: 0, engine_internal: 0, engine_test: 0 };
  const paramSchemaIds = new Set();
  const resultSchemaIds = new Set();

  for (let i = 0; i < methods.length; i++) {
    const m = methods[i];
    if (!m || typeof m !== "object") {
      throw new ContractError(fileLabel, `engine_methods[${i}]`, "", m, "必须是对象");
    }
    rejectUnknownFields(m, ALLOWED_METHOD_FIELDS, fileLabel, `engine_methods[${i}]`, "");

    if (typeof m.method !== "string" || m.method.length === 0) {
      throw new ContractError(fileLabel, "method", `#${i + 1}`, m.method, "必须为非空字符串");
    }
    if (seenMethods.has(m.method)) {
      throw new ContractError(
        fileLabel,
        "method",
        m.method,
        "",
        `重复声明（首次出现在 #${seenMethods.get(m.method) + 1}）`,
      );
    }
    seenMethods.set(m.method, i);

    if (!VALID_VISIBILITY.has(m.visibility)) {
      throw new ContractError(
        fileLabel,
        "visibility",
        m.method,
        m.visibility,
        "未知 visibility，合法值: engine_public/engine_internal/engine_test",
      );
    }
    visCounts[m.visibility] += 1;

    if (typeof m.python_handler !== "string" || m.python_handler.length === 0) {
      throw new ContractError(fileLabel, "python_handler", m.method, m.python_handler, "必须为非空字符串");
    }
    if (seenHandlers.has(m.python_handler)) {
      throw new ContractError(
        fileLabel,
        "python_handler",
        m.method,
        m.python_handler,
        `重复（已用于 ${seenHandlers.get(m.python_handler)}）`,
      );
    }
    seenHandlers.set(m.python_handler, m.method);

    const params = m.params;
    if (!params || typeof params !== "object") {
      throw new ContractError(fileLabel, "params", m.method, params, "必须为对象");
    }
    rejectUnknownFields(params, ALLOWED_PARAM_RESULT_FIELDS, fileLabel, `params (${m.method})`, m.method);
    if (!VALID_PARAM_KINDS.has(params.kind)) {
      throw new ContractError(
        fileLabel,
        "params.kind",
        m.method,
        params.kind,
        "未知 params.kind，合法值: empty_object/record/schema",
      );
    }
    if (params.kind === "schema") {
      if (typeof params.schema_id !== "string" || params.schema_id.length === 0) {
        throw new ContractError(
          fileLabel,
          "params.schema_id",
          m.method,
          params.schema_id,
          "params.kind=schema 时必须提供非空 schema_id",
        );
      }
      paramSchemaIds.add(params.schema_id);
    } else if (params.schema_id !== undefined) {
      throw new ContractError(
        fileLabel,
        "params.schema_id",
        m.method,
        params.schema_id,
        `params.kind=${params.kind} 时禁止携带 schema_id`,
      );
    }

    const result = m.result;
    if (!result || typeof result !== "object") {
      throw new ContractError(fileLabel, "result", m.method, result, "必须为对象");
    }
    rejectUnknownFields(result, ALLOWED_PARAM_RESULT_FIELDS, fileLabel, `result (${m.method})`, m.method);
    if (!VALID_RESULT_KINDS.has(result.kind)) {
      throw new ContractError(
        fileLabel,
        "result.kind",
        m.method,
        result.kind,
        "未知 result.kind，合法值: schema/empty_object",
      );
    }
    if (result.kind === "schema") {
      if (typeof result.schema_id !== "string" || result.schema_id.length === 0) {
        throw new ContractError(
          fileLabel,
          "result.schema_id",
          m.method,
          result.schema_id,
          "result.kind=schema 时必须提供非空 schema_id",
        );
      }
      resultSchemaIds.add(result.schema_id);
    } else if (result.schema_id !== undefined) {
      throw new ContractError(
        fileLabel,
        "result.schema_id",
        m.method,
        result.schema_id,
        `result.kind=${result.kind} 时禁止携带 schema_id`,
      );
    }
  }

  // 字典序校验
  const inOrder = methods.map((m) => m.method);
  for (let i = 1; i < inOrder.length; i++) {
    if (inOrder[i - 1] > inOrder[i]) {
      throw new ContractError(
        fileLabel,
        "engine_methods",
        inOrder[i],
        "",
        `方法未按字典序：${inOrder[i - 1]} 应排在 ${inOrder[i]} 之后`,
      );
    }
  }

  for (const [v, expected] of Object.entries(EXPECTED_VISIBILITY)) {
    if (visCounts[v] !== expected) {
      throw new ContractError(fileLabel, "visibility", v, visCounts[v], `数量必须为 ${expected}`);
    }
  }

  return {
    methods,
    paramSchemaIds: [...paramSchemaIds].sort(),
    resultSchemaIds: [...resultSchemaIds].sort(),
  };
}

/**
 * 校验 Electron 通道契约。
 * @param {unknown} data
 * @param {{ method: string }[]} engineMethods
 * @param {string} [fileLabel]
 */
export function validateElectronContract(data, engineMethods, fileLabel = "contracts/electron-channels.json") {
  if (!data || typeof data !== "object") {
    throw new ContractError(fileLabel, "file", "", data, "根必须是对象");
  }
  validateSchemaVersion(data.schema_version, fileLabel);
  rejectUnknownFields(data, ALLOWED_ELECTRON_TOP_FIELDS, fileLabel, "(顶层)", "");

  const channels = data.channels;
  if (!Array.isArray(channels)) {
    throw new ContractError(fileLabel, "channels", "", "", "必须是数组");
  }
  if (channels.length !== EXPECTED_CHANNEL_TOTAL) {
    throw new ContractError(
      fileLabel,
      "channels",
      "",
      channels.length,
      `通道数量必须为 ${EXPECTED_CHANNEL_TOTAL}`,
    );
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
    if (!c || typeof c !== "object") {
      throw new ContractError(fileLabel, `channels[${i}]`, "", c, "必须是对象");
    }
    rejectUnknownFields(c, ALLOWED_CHANNEL_FIELDS, fileLabel, `channels[${i}]`, "");

    if (typeof c.channel !== "string" || c.channel.length === 0) {
      throw new ContractError(fileLabel, "channel", `#${i + 1}`, c.channel, "必须为非空字符串");
    }
    if (seenChannels.has(c.channel)) {
      throw new ContractError(
        fileLabel,
        "channel",
        c.channel,
        "",
        `重复声明（首次出现在 #${seenChannels.get(c.channel) + 1}）`,
      );
    }
    seenChannels.set(c.channel, i);

    if (!VALID_CHANNEL_KINDS.has(c.kind)) {
      throw new ContractError(
        fileLabel,
        "kind",
        c.channel,
        c.kind,
        "未知 kind，合法值: electron_local/electron_forwarded/electron_test_local/electron_test_forwarded",
      );
    }
    kindCounts[c.kind] += 1;

    const isTest = c.channel.startsWith("test.");
    const isTestKind = c.kind.startsWith("electron_test_");
    if (isTest && !isTestKind) {
      throw new ContractError(fileLabel, "kind", c.channel, c.kind, "test. 前缀通道必须使用 electron_test_* kind");
    }
    if (!isTest && isTestKind) {
      throw new ContractError(fileLabel, "kind", c.channel, c.kind, "production 通道不得使用 electron_test_* kind");
    }

    const isForwarded = c.kind === "electron_forwarded" || c.kind === "electron_test_forwarded";
    const isLocal = c.kind === "electron_local" || c.kind === "electron_test_local";
    if (isForwarded) {
      if (typeof c.engine_method !== "string" || c.engine_method.length === 0) {
        throw new ContractError(fileLabel, "engine_method", c.channel, c.engine_method, "forwarded kind 必须提供 engine_method");
      }
      if (!engineMethodSet.has(c.engine_method)) {
        throw new ContractError(
          fileLabel,
          "engine_method",
          c.channel,
          c.engine_method,
          "引用的 Engine 方法不存在于 engine-methods.json",
        );
      }
    } else if (isLocal) {
      if (c.engine_method !== undefined) {
        throw new ContractError(fileLabel, "engine_method", c.channel, c.engine_method, "local kind 禁止携带 engine_method");
      }
    }

    // 暴露字段：必须是显式 boolean，且 test/production 字段不得互相冲突或缺失。
    if (c.preload_exposed !== undefined && typeof c.preload_exposed !== "boolean") {
      throw new ContractError(
        fileLabel,
        "preload_exposed",
        c.channel,
        c.preload_exposed,
        "必须为 boolean",
      );
    }
    if (c.preload_exposed_in_e2e_only !== undefined && typeof c.preload_exposed_in_e2e_only !== "boolean") {
      throw new ContractError(
        fileLabel,
        "preload_exposed_in_e2e_only",
        c.channel,
        c.preload_exposed_in_e2e_only,
        "必须为 boolean",
      );
    }
    const hasProd = c.preload_exposed === true;
    const hasTest = c.preload_exposed_in_e2e_only === true;
    if (c.preload_exposed !== undefined && c.preload_exposed_in_e2e_only !== undefined) {
      throw new ContractError(
        fileLabel,
        "preload_exposed",
        c.channel,
        "",
        "preload_exposed 与 preload_exposed_in_e2e_only 不得同时出现",
      );
    }
    if (isTestKind) {
      if (!hasTest) {
        throw new ContractError(
          fileLabel,
          "preload_exposed_in_e2e_only",
          c.channel,
          c.preload_exposed_in_e2e_only,
          "test 通道必须显式携带 preload_exposed_in_e2e_only: true",
        );
      }
      if (c.preload_exposed !== undefined) {
        throw new ContractError(
          fileLabel,
          "preload_exposed",
          c.channel,
          c.preload_exposed,
          "test 通道禁止使用 preload_exposed",
        );
      }
    } else {
      if (!hasProd) {
        throw new ContractError(
          fileLabel,
          "preload_exposed",
          c.channel,
          c.preload_exposed,
          "production 通道必须显式携带 preload_exposed: true",
        );
      }
      if (c.preload_exposed_in_e2e_only !== undefined) {
        throw new ContractError(
          fileLabel,
          "preload_exposed_in_e2e_only",
          c.channel,
          c.preload_exposed_in_e2e_only,
          "production 通道禁止使用 preload_exposed_in_e2e_only",
        );
      }
    }
    void hasProd;
    void hasTest;
  }

  // 字典序校验
  const inOrder = channels.map((c) => c.channel);
  for (let i = 1; i < inOrder.length; i++) {
    if (inOrder[i - 1] > inOrder[i]) {
      throw new ContractError(
        fileLabel,
        "channels",
        inOrder[i],
        "",
        `通道未按字典序：${inOrder[i - 1]} 应排在 ${inOrder[i]} 之后`,
      );
    }
  }

  for (const [k, expected] of Object.entries(EXPECTED_CHANNEL_KINDS)) {
    if (kindCounts[k] !== expected) {
      throw new ContractError(fileLabel, "kind", k, kindCounts[k], `数量必须为 ${expected}`);
    }
  }
}

/**
 * 根据校验后的 Engine 契约生成 TypeScript 文本。
 * @param {{ methods: any[], paramSchemaIds: string[], resultSchemaIds: string[] }} engine
 * @returns {string}
 */
export function generateTypeScript(engine) {
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

  // ENGINE_METHOD_RESULT_CONTRACT：method → { kind, schemaId? } 映射，由契约 result 字段派生。
  lines.push("/** 每个 Engine 方法的结果契约（由 engine-methods.json result 字段派生）。 */");
  lines.push("export const ENGINE_METHOD_RESULT_CONTRACT = {");
  for (const m of engine.methods) {
    const r = m.result;
    if (r.kind === "schema") {
      lines.push(`  ${JSON.stringify(m.method)}: { kind: "schema", schemaId: ${JSON.stringify(r.schema_id)} },`);
    } else if (r.kind === "empty_object") {
      lines.push(`  ${JSON.stringify(m.method)}: { kind: "empty_object" },`);
    } else {
      throw new Error(`未处理的 result.kind: ${r.kind} (method=${m.method})`);
    }
  }
  lines.push("} as const satisfies Record<EngineMethodName, EngineMethodResultEntry>;");
  lines.push("");

  lines.push("export type EngineMethodName = typeof ENGINE_METHOD_NAMES[number];");
  lines.push("export type EnginePublicMethodName = typeof ENGINE_PUBLIC_METHOD_NAMES[number];");
  lines.push("export type EngineInternalMethodName = typeof ENGINE_INTERNAL_METHOD_NAMES[number];");
  lines.push("export type EngineTestMethodName = typeof ENGINE_TEST_METHOD_NAMES[number];");
  lines.push("export type EngineParamSchemaId = typeof ENGINE_PARAM_SCHEMA_IDS[number];");
  lines.push("export type EngineResultSchemaId = typeof ENGINE_RESULT_SCHEMA_IDS[number];");
  lines.push("");
  lines.push("export type EngineMethodResultEntry =");
  lines.push("  | { readonly kind: \"schema\"; readonly schemaId: EngineResultSchemaId }");
  lines.push("  | { readonly kind: \"empty_object\" };");
  lines.push("export type EngineMethodVisibility =");
  lines.push('  | "engine_public"');
  lines.push('  | "engine_internal"');
  lines.push('  | "engine_test";');
  lines.push("");

  return lines.join("\n");
}

/**
 * 解析 JSON 文本。解析失败抛 ContractError（纯函数，不做文件 IO，由 CLI 读取文件后传入）。
 * @param {string} text
 * @param {string} fileLabel 用于错误消息的相对路径
 */
export function parseJsonText(text, fileLabel) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ContractError(fileLabel, "json", "", undefined, `解析失败: ${error.message}`);
  }
}
