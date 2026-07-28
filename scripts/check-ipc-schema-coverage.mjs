// P1-9：IPC schema 独立覆盖率预算检查。
//
// 读取 coverage/ipc-schema/coverage-summary.json，与 quality-budgets.json 的
// ipcSchemaCoverage 预算比对，低于阈值则 exit 1。

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const summaryPath = resolve(repoRoot, "coverage/ipc-schema/coverage-summary.json");
const budgetsPath = resolve(repoRoot, "scripts/quality-budgets.json");

const budgets = JSON.parse(readFileSync(budgetsPath, "utf8")).ipcSchemaCoverage;
const summary = JSON.parse(readFileSync(summaryPath, "utf8"));

const failures = [];
for (const [metric, floor] of Object.entries(budgets)) {
  const value = summary.total?.[metric]?.pct;
  if (typeof value !== "number") {
    failures.push(`ipc-schema total: missing ${metric} coverage`);
  } else if (value < floor) {
    failures.push(`ipc-schema total: ${metric} ${value}% < ${floor}%`);
  }
}

const result = {
  schema_version: 1,
  status: failures.length === 0 ? "PASS" : "FAIL",
  source: "coverage/ipc-schema/coverage-summary.json",
  measured_total: summary.total,
  budgets,
  failures,
};
console.log(JSON.stringify(result, null, 2));
if (failures.length > 0) process.exitCode = 1;
