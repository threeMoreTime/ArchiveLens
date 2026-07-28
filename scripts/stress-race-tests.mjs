// ArchiveLens 竞态测试压力验证入口（P1-9 Commit 1）。
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
//
// 退出码：有任一迭代失败则 1，全部成功则 0。

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

function parseArgs(argv) {
  const args = { target: "export", iterations: 30, maxWorkers: null, failFast: false };
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
    } else if (a === "--help" || a === "-h") {
      console.log(`用法: node scripts/stress-race-tests.mjs --target <export|search|combined|desktop> --iterations N [--max-workers N] [--fail-fast]
默认: --target export --iterations 30`);
      process.exit(0);
    } else {
      console.error(`未知参数: ${a}`);
      console.error("用法: node scripts/stress-race-tests.mjs --target <export|search|combined|desktop> --iterations N [--max-workers N] [--fail-fast]");
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
  return args;
}

// 用 process.execPath（node）直接调用 vitest 的 JS 入口（dist/cli.js），
// shell: false 遵循 AGENTS.md 子进程安全要求（不拼命令字符串，参数数组传递）。
const VITEST_JS = path.join(DESKTOP_DIR, "node_modules", "vitest", "dist", "cli.js");

function runOneIteration(target, maxWorkers) {
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
  });
  const elapsed = performance.now() - t0;
  return {
    exitCode: result.status,
    elapsed,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function main() {
  const args = parseArgs(process.argv);
  console.error(`[stress] target=${args.target} iterations=${args.iterations}${args.maxWorkers !== null ? ` maxWorkers=${args.maxWorkers}` : ""}${args.failFast ? " failFast" : ""}`);

  const results = [];
  let firstFailure = null;

  for (let i = 1; i <= args.iterations; i++) {
    process.stdout.write(`[stress] iteration ${i}/${args.iterations} ... `);
    const r = runOneIteration(args.target, args.maxWorkers);
    const status = r.exitCode === 0 ? "PASS" : "FAIL";
    process.stdout.write(`${status} (${(r.elapsed / 1000).toFixed(1)}s)\n`);
    results.push({ iteration: i, ...r });
    if (r.exitCode !== 0 && !firstFailure) {
      // 提取失败位置（vitest 输出中第一个 FAIL 行）
      const failLine = (r.stdout + r.stderr).split("\n").find((l) => l.includes("FAIL")) || "(未找到 FAIL 行)";
      firstFailure = { iteration: i, exitCode: r.exitCode, failLine, elapsed: r.elapsed };
      console.error(`[stress] 首次失败: iteration ${i}`);
      console.error(`[stress]   ${failLine}`);
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
    console.error(`[stress]   ${firstFailure.failLine}`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
