// ArchiveLens IPC 契约代码生成器 CLI（P1-8）。
//
// 输入：contracts/engine-methods.json、contracts/electron-channels.json
// 输出：packages/ipc-schema/src/generated/engineMethods.generated.ts
//
// 用法：
//   node scripts/generate-ipc-contract.mjs          生成（写入磁盘）
//   node scripts/generate-ipc-contract.mjs --check  仅比对，不写盘，不一致 exit 1
//
// 校验与生成逻辑位于 scripts/ipc-contract-core.mjs（可被 node:test 直接 import）。

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ContractError,
  validateEngineContract,
  validateElectronContract,
  generateTypeScript,
  parseJsonText,
} from "./ipc-contract-core.mjs";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");
const ENGINE_CONTRACT = path.join(REPO_ROOT, "contracts", "engine-methods.json");
const ELECTRON_CONTRACT = path.join(REPO_ROOT, "contracts", "electron-channels.json");
const OUTPUT = path.join(REPO_ROOT, "packages", "ipc-schema", "src", "generated", "engineMethods.generated.ts");

function readContract(filePath) {
  const rel = path.relative(REPO_ROOT, filePath);
  if (!existsSync(filePath)) {
    throw new ContractError(rel, "file", "", undefined, "文件不存在");
  }
  return parseJsonText(readFileSync(filePath, "utf-8"), rel);
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
    engine = validateEngineContract(readContract(ENGINE_CONTRACT));
    validateElectronContract(readContract(ELECTRON_CONTRACT), engine.methods);
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
      // 规范化换行：git autocrlf 可能在 checkout 时把 LF 转成 CRLF，
      // 比对基于逻辑内容（统一为 LF），避免跨平台误报不一致。
      onDisk = readFileSync(OUTPUT, "utf-8").replace(/\r\n/g, "\n");
    }
    if (onDisk !== generated) {
      console.error(`[ipc-contract] 生成文件与磁盘不一致: ${path.relative(REPO_ROOT, OUTPUT)}`);
      console.error("[ipc-contract] 修复命令: node scripts/generate-ipc-contract.mjs");
      process.exit(1);
    }
    console.error(
      `[ipc-contract] --check 通过: ${path.relative(REPO_ROOT, OUTPUT)} 已是最新（42 方法，38/3/1 分类）。`,
    );
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
