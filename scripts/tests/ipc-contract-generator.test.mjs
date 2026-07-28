// ArchiveLens IPC 契约生成器畸形测试（P1-8 Commit 4）。
//
// 使用 Node 内置 node:test + node:assert/strict，不引入新测试依赖。
// 从真实合法契约深拷贝后单点变异，不修改磁盘正式文件。
// 每项必须断言错误消息包含具体字段或具体条目，不能只断言“抛错”。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ContractError,
  validateEngineContract,
  validateElectronContract,
  generateTypeScript,
  parseJsonText,
} from "../ipc-contract-core.mjs";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");
const ENGINE_CONTRACT_PATH = path.join(REPO_ROOT, "contracts", "engine-methods.json");
const ELECTRON_CONTRACT_PATH = path.join(REPO_ROOT, "contracts", "electron-channels.json");

const ENGINE_FILE = "contracts/engine-methods.json";
const ELECTRON_FILE = "contracts/electron-channels.json";

/** 深拷贝真实合法契约。 */
function cloneEngine() {
  return JSON.parse(JSON.stringify(JSON.parse(readFileSync(ENGINE_CONTRACT_PATH, "utf-8"))));
}
function cloneElectron() {
  return JSON.parse(JSON.stringify(JSON.parse(readFileSync(ELECTRON_CONTRACT_PATH, "utf-8"))));
}

/** 断言某变异抛 ContractError 且消息包含全部 expectedSubstrings。 */
function assertRejects(mutate, fileLabel, expectedSubstrings) {
  const data = mutate();
  assert.throws(
    () => validateEngineContract(data, fileLabel),
    (err) => {
      assert.ok(err instanceof ContractError, `应为 ContractError，实际 ${err?.constructor?.name}`);
      for (const sub of expectedSubstrings) {
        assert.ok(
          err.message.includes(sub),
          `错误消息应包含 "${sub}"，实际: ${err.message}`,
        );
      }
      return true;
    },
  );
}

function assertRejectsElectron(mutate, fileLabel, expectedSubstrings) {
  const data = mutate();
  // Engine methods 作为引用上下文（合法集）
  const engine = validateEngineContract(cloneEngine());
  assert.throws(
    () => validateElectronContract(data, engine.methods, fileLabel),
    (err) => {
      assert.ok(err instanceof ContractError, `应为 ContractError，实际 ${err?.constructor?.name}`);
      for (const sub of expectedSubstrings) {
        assert.ok(
          err.message.includes(sub),
          `错误消息应包含 "${sub}"，实际: ${err.message}`,
        );
      }
      return true;
    },
  );
}

test("合法契约通过校验", () => {
  const engine = validateEngineContract(cloneEngine(), ENGINE_FILE);
  assert.equal(engine.methods.length, 42);
  const electron = cloneElectron();
  validateElectronContract(electron, engine.methods, ELECTRON_FILE);
});

test("连续生成两次文本完全相同", () => {
  const engine = validateEngineContract(cloneEngine(), ENGINE_FILE);
  const a = generateTypeScript(engine);
  const b = generateTypeScript(validateEngineContract(cloneEngine(), ENGINE_FILE));
  assert.equal(a, b);
});

test("输出仅使用 LF、无 BOM、恰好一个尾随换行", () => {
  const engine = validateEngineContract(cloneEngine(), ENGINE_FILE);
  const out = generateTypeScript(engine);
  assert.equal(out.includes("\r\n"), false, "不应包含 CRLF");
  assert.ok(!out.startsWith("\uFEFF"), "不应有 BOM");
  assert.ok(out.endsWith("\n") && !out.endsWith("\n\n"), "应恰好一个尾随换行");
});

test("输出不包含时间戳与 python_handler", () => {
  const engine = validateEngineContract(cloneEngine(), ENGINE_FILE);
  const out = generateTypeScript(engine);
  assert.ok(!out.includes("python_handler"), "生成文件不应暴露 python_handler");
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(out), "不应有时间戳");
});

// ---- Engine schema_version 变异 ----
test("Engine schema_version=2 失败", () => {
  assertRejects(
    () => {
      const d = cloneEngine();
      d.schema_version = 2;
      return d;
    },
    ENGINE_FILE,
    ["schema_version", "2"],
  );
});

test("Engine schema_version=1.5 失败", () => {
  assertRejects(
    () => {
      const d = cloneEngine();
      d.schema_version = 1.5;
      return d;
    },
    ENGINE_FILE,
    ["schema_version", "1.5"],
  );
});

test("Electron schema_version 缺失失败", () => {
  assertRejectsElectron(
    () => {
      const d = cloneElectron();
      delete d.schema_version;
      return d;
    },
    ELECTRON_FILE,
    ["schema_version"],
  );
});

// ---- duplicate ----
test("duplicate method 失败", () => {
  assertRejects(
    () => {
      const d = cloneEngine();
      // 将第二个方法改名为与第一个相同（保持总数 42，触发重复校验）
      d.engine_methods[1].method = d.engine_methods[0].method;
      return d;
    },
    ENGINE_FILE,
    ["method", "重复"],
  );
});

test("duplicate python_handler 失败", () => {
  assertRejects(
    () => {
      const d = cloneEngine();
      // app.info 的 python_handler 复制给第二个方法（保持总数，触发重复）
      d.engine_methods[1].python_handler = d.engine_methods[0].python_handler;
      return d;
    },
    ENGINE_FILE,
    ["python_handler", "重复"],
  );
});

test("duplicate channel 失败", () => {
  assertRejectsElectron(
    () => {
      const d = cloneElectron();
      // 将第二个通道改名为与第一个相同（保持总数 71，触发重复校验）
      d.channels[1].channel = d.channels[0].channel;
      return d;
    },
    ELECTRON_FILE,
    ["channel", "重复"],
  );
});

// ---- unknown enum ----
test("unknown visibility 失败", () => {
  assertRejects(
    () => {
      const d = cloneEngine();
      d.engine_methods[0].visibility = "engine_secret";
      return d;
    },
    ENGINE_FILE,
    ["visibility", "engine_secret"],
  );
});

test("unknown params.kind 失败", () => {
  assertRejects(
    () => {
      const d = cloneEngine();
      d.engine_methods[0].params = { kind: "magic" };
      return d;
    },
    ENGINE_FILE,
    ["params.kind", "magic"],
  );
});

test("unknown result.kind 失败", () => {
  assertRejects(
    () => {
      const d = cloneEngine();
      d.engine_methods[0].result = { kind: "stream" };
      return d;
    },
    ENGINE_FILE,
    ["result.kind", "stream"],
  );
});

// ---- schema_id 缺失/错带 ----
test("schema kind 缺少 schema_id 失败", () => {
  assertRejects(
    () => {
      const d = cloneEngine();
      delete d.engine_methods[0].result.schema_id;
      return d;
    },
    ENGINE_FILE,
    ["result.schema_id"],
  );
});

test("record kind 错误携带 schema_id 失败", () => {
  assertRejects(
    () => {
      const d = cloneEngine();
      // tasks.start 是 record，给它加 schema_id
      const startMethod = d.engine_methods.find((m) => m.method === "tasks.start");
      startMethod.params.schema_id = "Foo";
      return d;
    },
    ENGINE_FILE,
    ["params.schema_id", "禁止"],
  );
});

// ---- forwarded / local 引用 ----
test("forwarded 缺少 engine_method 失败", () => {
  assertRejectsElectron(
    () => {
      const d = cloneElectron();
      const ch = d.channels.find((c) => c.kind === "electron_forwarded");
      delete ch.engine_method;
      return d;
    },
    ELECTRON_FILE,
    ["engine_method", "forwarded"],
  );
});

test("forwarded 引用不存在失败", () => {
  assertRejectsElectron(
    () => {
      const d = cloneElectron();
      const ch = d.channels.find((c) => c.kind === "electron_forwarded");
      ch.engine_method = "bogus.method";
      return d;
    },
    ELECTRON_FILE,
    ["engine_method", "bogus.method"],
  );
});

test("local 携带 engine_method 失败", () => {
  assertRejectsElectron(
    () => {
      const d = cloneElectron();
      const ch = d.channels.find((c) => c.kind === "electron_local");
      ch.engine_method = "app.info";
      return d;
    },
    ELECTRON_FILE,
    ["engine_method", "local"],
  );
});

// ---- test/production 前缀不一致 ----
test("test channel 使用生产 kind 失败", () => {
  assertRejectsElectron(
    () => {
      const d = cloneElectron();
      const ch = d.channels.find((c) => c.channel.startsWith("test."));
      ch.kind = "electron_local";
      return d;
    },
    ELECTRON_FILE,
    ["kind", "test"],
  );
});

test("production channel 使用 test kind 失败", () => {
  assertRejectsElectron(
    () => {
      const d = cloneElectron();
      const ch = d.channels.find((c) => !c.channel.startsWith("test.") && c.kind === "electron_local");
      ch.kind = "electron_test_local";
      return d;
    },
    ELECTRON_FILE,
    ["kind", "production"],
  );
});

// ---- preload 字段 ----
test("production preload 字段缺失失败", () => {
  assertRejectsElectron(
    () => {
      const d = cloneElectron();
      const ch = d.channels.find((c) => c.kind === "electron_local");
      delete ch.preload_exposed;
      return d;
    },
    ELECTRON_FILE,
    ["preload_exposed", "production"],
  );
});

test("test E2E preload 字段缺失失败", () => {
  assertRejectsElectron(
    () => {
      const d = cloneElectron();
      const ch = d.channels.find((c) => c.channel.startsWith("test."));
      delete ch.preload_exposed_in_e2e_only;
      return d;
    },
    ELECTRON_FILE,
    ["preload_exposed_in_e2e_only"],
  );
});

test("preload 字段冲突失败", () => {
  assertRejectsElectron(
    () => {
      const d = cloneElectron();
      const ch = d.channels.find((c) => c.kind === "electron_local");
      ch.preload_exposed_in_e2e_only = true;
      return d;
    },
    ELECTRON_FILE,
    ["preload_exposed", "同时出现"],
  );
});

test("preload 字段类型不是 boolean 失败", () => {
  assertRejectsElectron(
    () => {
      const d = cloneElectron();
      const ch = d.channels.find((c) => c.kind === "electron_local");
      ch.preload_exposed = "yes";
      return d;
    },
    ELECTRON_FILE,
    ["preload_exposed", "boolean"],
  );
});

// ---- 未知字段 ----
test("未知 Engine 顶层字段失败", () => {
  assertRejects(
    () => {
      const d = cloneEngine();
      d.bogus_top = 1;
      return d;
    },
    ENGINE_FILE,
    ["bogus_top", "未知字段"],
  );
});

test("未知 method 字段失败", () => {
  assertRejects(
    () => {
      const d = cloneEngine();
      d.engine_methods[0].bogus_field = 1;
      return d;
    },
    ENGINE_FILE,
    ["bogus_field", "未知字段"],
  );
});

test("未知 Electron channel 字段失败", () => {
  assertRejectsElectron(
    () => {
      const d = cloneElectron();
      d.channels[0].bogus_field = 1;
      return d;
    },
    ELECTRON_FILE,
    ["bogus_field", "未知字段"],
  );
});

// ---- 字典序 ----
test("方法顺序错误失败", () => {
  assertRejects(
    () => {
      const d = cloneEngine();
      // 交换前两项
      const m = d.engine_methods;
      [m[0], m[1]] = [m[1], m[0]];
      return d;
    },
    ENGINE_FILE,
    ["字典序"],
  );
});

test("通道顺序错误失败", () => {
  assertRejectsElectron(
    () => {
      const d = cloneElectron();
      const c = d.channels;
      [c[0], c[1]] = [c[1], c[0]];
      return d;
    },
    ELECTRON_FILE,
    ["字典序"],
  );
});

// ---- protocol version ----
test("protocol version 非 4 失败", () => {
  assertRejects(
    () => {
      const d = cloneEngine();
      d.protocol_version = 5;
      return d;
    },
    ENGINE_FILE,
    ["protocol_version", "5"],
  );
});

// ---- JSON 解析 ----
test("parseJsonText 解析失败抛 ContractError", () => {
  assert.throws(
    () => parseJsonText("{ invalid", "foo.json"),
    (err) => {
      assert.ok(err instanceof ContractError);
      assert.ok(err.message.includes("解析失败"));
      assert.ok(err.message.includes("foo.json"));
      return true;
    },
  );
});
