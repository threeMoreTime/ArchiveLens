import { gzipSync } from "node:zlib";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const budgets = JSON.parse(readFileSync(resolve(repoRoot, "scripts/quality-budgets.json"), "utf8")).bundles;

function measureFiles(paths) {
  return paths.reduce((result, path) => {
    const content = readFileSync(path);
    result.raw += content.byteLength;
    result.gzip += gzipSync(content, { level: 9 }).byteLength;
    result.files.push(path.slice(repoRoot.length + 1).replaceAll("\\", "/"));
    return result;
  }, { raw: 0, gzip: 0, files: [] });
}

const rendererAssets = resolve(repoRoot, "apps/desktop/out/renderer/assets");
const assetFiles = readdirSync(rendererAssets).map((name) => join(rendererAssets, name));
const measurements = {
  rendererJs: measureFiles(assetFiles.filter((path) => extname(path) === ".js")),
  rendererCss: measureFiles(assetFiles.filter((path) => extname(path) === ".css")),
  mainJs: measureFiles([resolve(repoRoot, "apps/desktop/out/main/index.js")]),
  preloadJs: measureFiles([resolve(repoRoot, "apps/desktop/out/preload/index.js")]),
};
const warnings = [];
const failures = [];

for (const [name, measured] of Object.entries(measurements)) {
  const budget = budgets[name];
  if (measured.files.length === 0 || measured.files.some((path) => !statSync(resolve(repoRoot, path)).isFile())) {
    failures.push(`${name}: expected build output is missing`);
    continue;
  }
  if (measured.raw > budget.failureRaw) failures.push(`${name}: raw ${measured.raw} > ${budget.failureRaw}`);
  else if (measured.raw > budget.warningRaw) warnings.push(`${name}: raw ${measured.raw} > ${budget.warningRaw}`);
  if (measured.gzip > budget.failureGzip) failures.push(`${name}: gzip ${measured.gzip} > ${budget.failureGzip}`);
  else if (measured.gzip > budget.warningGzip) warnings.push(`${name}: gzip ${measured.gzip} > ${budget.warningGzip}`);
}

const result = {
  schema_version: 1,
  status: failures.length === 0 ? "PASS" : "FAIL",
  unit: "bytes",
  gzip_level: 9,
  measurements,
  budgets,
  warnings,
  failures,
};
const outputPath = resolve(repoRoot, "coverage/bundle-budget.json");
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result, null, 2));
if (failures.length > 0) process.exitCode = 1;
