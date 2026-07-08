import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

const [, , target, ...rawArgs] = process.argv;

if (!target || !["desktop", "engine"].includes(target)) {
  console.error("usage: node scripts/write-build-metadata.mjs <desktop|engine> <outputPath...> [--python-version <value>]");
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPaths = [];
const optionArgs = [];
for (const value of rawArgs) {
  if (value.startsWith("--") || optionArgs.length > 0) {
    optionArgs.push(value);
  } else {
    outputPaths.push(value);
  }
}

if (outputPaths.length === 0) {
  console.error("at least one output path is required");
  process.exit(2);
}

const args = new Map();
for (let i = 0; i < optionArgs.length; i += 2) {
  args.set(optionArgs[i], optionArgs[i + 1] ?? "");
}

function run(command, commandArgs, fallback = "") {
  try {
    return execFileSync(command, commandArgs, {
      cwd: root,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return fallback;
  }
}

function parseProtocolVersion() {
  const schema = readFileSync(path.join(root, "packages", "ipc-schema", "src", "index.ts"), "utf-8");
  const match = schema.match(/PROTOCOL_VERSION\s*=\s*(\d+)/);
  return match ? Number.parseInt(match[1], 10) : 1;
}

function parseEngineVersion() {
  const initPy = readFileSync(path.join(root, "engine", "src", "archivelens_engine", "__init__.py"), "utf-8");
  const match = initPy.match(/__version__\s*=\s*"([^"]+)"/);
  if (!match) {
    throw new Error("failed to parse engine version");
  }
  return match[1];
}

function parseDesktopVersion() {
  const pkg = JSON.parse(readFileSync(path.join(root, "apps", "desktop", "package.json"), "utf-8"));
  return pkg.version;
}

function parseElectronVersion() {
  const pkg = JSON.parse(readFileSync(path.join(root, "apps", "desktop", "package.json"), "utf-8"));
  const value = pkg.devDependencies?.electron ?? "";
  return String(value).replace(/^[^\d]*/, "");
}

const commit = run("git", ["-C", root, "rev-parse", "HEAD"]);
if (!commit) {
  console.error("failed to resolve git HEAD");
  process.exit(1);
}

const pythonVersion =
  args.get("--python-version") ||
  process.env.ARCHIVELENS_PYTHON_VERSION ||
  run("python", ["-c", "import platform; print(platform.python_version())"]);

const metadata = {
  version: target === "desktop" ? parseDesktopVersion() : parseEngineVersion(),
  git_commit: commit,
  build_time: new Date().toISOString(),
  python_version: pythonVersion || "",
  node_version: process.version,
  electron_version: parseElectronVersion(),
  protocol_version: parseProtocolVersion(),
};

const outputs = outputPaths.map((outputPath) => {
  const absoluteOutput = path.resolve(root, outputPath);
  mkdirSync(path.dirname(absoluteOutput), { recursive: true });
  writeFileSync(absoluteOutput, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");
  return absoluteOutput;
});

console.log(JSON.stringify({ target, outputs, metadata }, null, 2));
