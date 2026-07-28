// ArchiveLens 竞态测试压力验证入口（P1-9）。
//
// 通过 spawnSync 用 process.execPath（node）直接调用 vitest 的 JS 入口，
// 对竞态测试重复运行，记录每次迭代的耗时与退出码，输出汇总。
// 不依赖 Bash、不使用 shell: true（遵循 AGENTS.md 子进程安全要求），Windows CI 可运行。
//
// 用法：
//   node scripts/stress-race-tests.mjs --target export --iterations 30
//   node scripts/stress-race-tests.mjs --target search --iterations 30
//   node scripts/stress-race-tests.mjs --target combined --iterations 30
//   node scripts/stress-race-tests.mjs --target desktop --iterations 3
//   node scripts/stress-race-tests.mjs --target export --iterations 30 --max-workers 1
//   node scripts/stress-race-tests.mjs --target export --iterations 30 --fail-fast
//   node scripts/stress-race-tests.mjs --target combined --iterations 30 --iteration-timeout-ms 180000
//
// 退出码：有任一迭代失败或超时则 1，全部成功则 0。

import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 用 fileURLToPath 保持绝对路径（POSIX 不丢失前导斜杠，Windows 正确解码）。
const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DESKTOP_DIR = path.join(REPO_ROOT, "apps", "desktop");

const TARGETS = {
  export: ["tests/exportPageRace.spec.tsx"],
  search: ["tests/searchPageRace.spec.tsx"],
  combined: ["tests/exportPageRace.spec.tsx", "tests/searchPageRace.spec.tsx"],
  desktop: [], // 空数组表示全量（不传文件参数）
};

// 默认单次迭代超时：combined 历史最大 ~42s，desktop 全量 ~60s，留充足余量。
const DEFAULT_ITERATION_TIMEOUT_MS = 180_000;

function parseArgs(argv) {
  const args = {
    target: "export",
    iterations: 30,
    maxWorkers: null,
    failFast: false,
    iterationTimeoutMs: DEFAULT_ITERATION_TIMEOUT_MS,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target") {
      args.target = argv[++i];
    } else if (a === "--iterations") {
      args.iterations = parseInt(argv[++i], 10);
    } else if (a === "--max-workers") {
      args.maxWorkers = parseInt(argv[++i], 10);
    } else if (a === "--fail-fast") {
      args.failFast = true;
    } else if (a === "--iteration-timeout-ms") {
      args.iterationTimeoutMs = parseInt(argv[++i], 10);
    } else if (a === "--help" || a === "-h") {
      console.log(`用法: node scripts/stress-race-tests.mjs --target <export|search|combined|desktop> --iterations N [--max-workers N] [--fail-fast] [--iteration-timeout-ms N]
默认: --target export --iterations 30 --iteration-timeout-ms ${DEFAULT_ITERATION_TIMEOUT_MS}`);
      process.exit(0);
    } else {
      console.error(`未知参数: ${a}`);
      console.error("用法: node scripts/stress-race-tests.mjs --target <export|search|combined|desktop> --iterations N [--max-workers N] [--fail-fast] [--iteration-timeout-ms N]");
      process.exit(2);
    }
  }
  if (!(args.target in TARGETS)) {
    console.error(`未知 target: ${args.target}，合法值: ${Object.keys(TARGETS).join("/")}`);
    process.exit(2);
  }
  if (!Number.isInteger(args.iterations) || args.iterations < 1) {
    console.error(`--iterations 必须为正整数，实际: ${args.iterations}`);
    process.exit(2);
  }
  if (!Number.isInteger(args.iterationTimeoutMs) || args.iterationTimeoutMs < 1000) {
    console.error(`--iteration-timeout-ms 必须为 >= 1000 的整数，实际: ${args.iterationTimeoutMs}`);
    process.exit(2);
  }
  return args;
}

// 用 process.execPath（node）直接调用 vitest 的 JS 入口（dist/cli.js），
// shell: false 遵循 AGENTS.md 子进程安全要求（不拼命令字符串，参数数组传递）。
const VITEST_JS = path.join(DESKTOP_DIR, "node_modules", "vitest", "dist", "cli.js");

function runOneIteration(target, maxWorkers, iterationTimeoutMs) {
  const files = TARGETS[target];
  const args = [VITEST_JS, "run"];
  if (files.length > 0) {
    args.push(...files);
  }
  if (maxWorkers !== null) {
    args.push("--maxWorkers", String(maxWorkers));
  }
  const t0 = performance.now();
  const result = spawnSync(process.execPath, args, {
    cwd: DESKTOP_DIR,
    stdio: "pipe",
    encoding: "utf-8",
    shell: false,
    timeout: iterationTimeoutMs,
  });
  const elapsed = performance.now() - t0;

  // 处理超时与异常
  const timedOut = result.status === null && result.signal === "SIGTERM";
  const errored = result.error !== undefined;
  const combinedOutput = (result.stdout || "") + (result.stderr || "");
  const failLine = combinedOutput.split("\n").find((l) => l.includes("FAIL")) || null;

  return {
    exitCode: result.status,
    elapsed,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    signal: result.signal,
    errorCode: result.error?.code || null,
    timedOut,
    errored,
    failLine,
  };
}

function main() {
  const args = parseArgs(process.argv);
  console.error(`[stress] target=${args.target} iterations=${args.iterations}${args.maxWorkers !== null ? ` maxWorkers=${args.maxWorkers}` : ""}${args.failFast ? " failFast" : ""} iterationTimeoutMs=${args.iterationTimeoutMs}`);

  const results = [];
  let firstFailure = null;

  for (let i = 1; i <= args.iterations; i++) {
    process.stdout.write(`[stress] iteration ${i}/${args.iterations} ... `);
    const r = runOneIteration(args.target, args.maxWorkers, args.iterationTimeoutMs);
    const status = r.exitCode === 0 ? "PASS" : "FAIL";
    const detail = r.timedOut ? " TIMEOUT" : r.errored ? ` ERROR(${r.errorCode})` : "";
    process.stdout.write(`${status}${detail} (${(r.elapsed / 1000).toFixed(1)}s)\n`);
    results.push({ iteration: i, ...r });
    if (r.exitCode !== 0 && !firstFailure) {
      firstFailure = {
        iteration: i,
        target: args.target,
        exitCode: r.exitCode,
        signal: r.signal,
        errorCode: r.errorCode,
        timedOut: r.timedOut,
        elapsed: r.elapsed,
        failLine: r.failLine,
      };
      console.error(`[stress] 首次失败: iteration ${i}`);
      console.error(`[stress]   target:   ${args.target}`);
      console.error(`[stress]   elapsed:  ${(r.elapsed / 1000).toFixed(1)}s`);
      console.error(`[stress]   exitCode: ${r.exitCode}`);
      console.error(`[stress]   signal:   ${r.signal}`);
      console.error(`[stress]   errorCode: ${r.errorCode}`);
      console.error(`[stress]   timedOut: ${r.timedOut}`);
      console.error(`[stress]   failLine: ${r.failLine || "(未找到 FAIL 行)"}`);
      if (args.failFast) {
        console.error("[stress] --fail-fast 触发，停止后续迭代");
        break;
      }
    }
  }

  const passed = results.filter((r) => r.exitCode === 0).length;
  const failed = results.filter((r) => r.exitCode !== 0).length;
  const elapsedTotal = results.reduce((sum, r) => sum + r.elapsed, 0);
  const elapsedAvg = elapsedTotal / results.length;
  const elapsedMax = Math.max(...results.map((r) => r.elapsed));
  const elapsedMin = Math.min(...results.map((r) => r.elapsed));

  console.error("");
  console.error("[stress] === 汇总 ===");
  console.error(`[stress] target:       ${args.target}`);
  console.error(`[stress] iterations:   ${results.length}/${args.iterations}`);
  console.error(`[stress] passed:       ${passed}`);
  console.error(`[stress] failed:       ${failed}`);
  console.error(`[stress] total time:   ${(elapsedTotal / 1000).toFixed(1)}s`);
  console.error(`[stress] avg:          ${(elapsedAvg / 1000).toFixed(1)}s`);
  console.error(`[stress] min:          ${(elapsedMin / 1000).toFixed(1)}s`);
  console.error(`[stress] max:          ${(elapsedMax / 1000).toFixed(1)}s`);
  if (firstFailure) {
    console.error(`[stress] first fail:  iteration ${firstFailure.iteration}`);
    console.error(`[stress]   target:    ${firstFailure.target}`);
    console.error(`[stress]   elapsed:   ${(firstFailure.elapsed / 1000).toFixed(1)}s`);
    console.error(`[stress]   exitCode:  ${firstFailure.exitCode}`);
    console.error(`[stress]   signal:    ${firstFailure.signal}`);
    console.error(`[stress]   errorCode: ${firstFailure.errorCode}`);
    console.error(`[stress]   timedOut:  ${firstFailure.timedOut}`);
    console.error(`[stress]   failLine:  ${firstFailure.failLine || "(未找到 FAIL 行)"}`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
