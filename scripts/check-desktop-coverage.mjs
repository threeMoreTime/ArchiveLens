import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const summaryPath = resolve(repoRoot, "coverage/desktop/coverage-summary.json");
const outputPath = resolve(repoRoot, "coverage/desktop/budget-summary.json");
const budgets = JSON.parse(readFileSync(resolve(repoRoot, "scripts/quality-budgets.json"), "utf8")).desktopCoverage;
const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
const failures = [];

function normalize(value) {
  return value.replaceAll("\\", "/").toLowerCase();
}

function checkMetrics(label, actual, expected) {
  for (const [metric, floor] of Object.entries(expected)) {
    const value = actual?.[metric]?.pct;
    if (typeof value !== "number") {
      failures.push(`${label}: missing ${metric} coverage`);
    } else if (value < floor) {
      failures.push(`${label}: ${metric} ${value}% < ${floor}%`);
    }
  }
}

checkMetrics("desktop total", summary.total, budgets.total);
for (const [relativePath, expected] of Object.entries(budgets.files)) {
  const suffix = normalize(relativePath);
  const entry = Object.entries(summary).find(([path]) => normalize(path).endsWith(suffix));
  if (!entry) failures.push(`${relativePath}: coverage entry is missing`);
  else checkMetrics(relativePath, entry[1], expected);
}

const result = {
  schema_version: 1,
  status: failures.length === 0 ? "PASS" : "FAIL",
  source: "coverage/desktop/coverage-summary.json",
  measured_total: summary.total,
  budgets,
  failures,
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result, null, 2));
if (failures.length > 0) process.exitCode = 1;
