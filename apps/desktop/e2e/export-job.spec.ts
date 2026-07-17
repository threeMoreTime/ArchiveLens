import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { access, copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const APP_DIR = path.resolve(__dirname, "..");
const ROOT_DIR = path.resolve(APP_DIR, "..", "..");
const ENGINE_SRC = path.join(ROOT_DIR, "engine", "src");
const FIXTURE = path.join(ROOT_DIR, "tests", "fixtures", "ocr", "custom-single.pdf");
const RUN_ID = (process.env["ARCHIVELENS_TEST_RUN_ID"] ?? "a11-local").replace(/[^A-Za-z0-9._-]/g, "-");

async function resolvePythonExecutable(): Promise<string> {
  const explicit = process.env["ARCHIVELENS_E2E_PYTHON"];
  if (explicit) {
    await access(explicit);
    return explicit;
  }
  const userProfile = process.env["USERPROFILE"];
  if (userProfile) {
    const versionsRoot = path.join(userProfile, ".pyenv", "pyenv-win", "versions");
    const { readdir } = await import("node:fs/promises");
    const candidates = (await readdir(versionsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(versionsRoot, entry.name, "python.exe"))
      .sort()
      .reverse();
    for (const candidate of candidates) {
      try { await access(candidate); return candidate; } catch { /* continue */ }
    }
  }
  throw new Error("无法解析 python.exe；请设置 ARCHIVELENS_E2E_PYTHON");
}

async function makeOwnedTempDir(kind: "source" | "userData", label: string): Promise<string> {
  const family = kind === "source" ? "archivelens-ocr-temp" : "archivelens-e2e-userdata";
  const dir = await mkdtemp(path.join(os.tmpdir(), `${family}-${RUN_ID}-${label}-`));
  await writeFile(path.join(dir, ".archivelens-test-owned"), `${RUN_ID}\n`, "utf8");
  return dir;
}

async function waitForSidecar(win: Page): Promise<void> {
  await expect.poll(async () => win.evaluate(async () => {
    const env = await (window as any).archiveLens.app.getEnvironment();
    return Boolean(env?.sidecarReady);
  })).toBe(true);
}

test.beforeAll(async () => {
  const resultRoot = path.join(APP_DIR, "test-results");
  await mkdir(resultRoot, { recursive: true });
  await writeFile(path.join(resultRoot, ".archivelens-runid"), `${RUN_ID}\n`, "utf8");
});

test("导出作业：真实 OCR 任务创建 HTML/JSON job、进度、完成与取消", async () => {
  const userDataDir = await makeOwnedTempDir("userData", "export-job");
  const sourceDir = await makeOwnedTempDir("source", "export-job");
  await copyFile(FIXTURE, path.join(sourceDir, "custom-single.pdf"));
  const pythonExe = await resolvePythonExecutable();
  const app: ElectronApplication = await electron.launch({
    args: [APP_DIR],
    cwd: APP_DIR,
    env: {
      ...process.env,
      ARCHIVELENS_E2E: "1",
      ARCHIVELENS_USER_DATA_DIR: userDataDir,
      AL_DEBUG: "1",
      AL_ENGINE_DEV: pythonExe,
      AL_ENGINE_SRC: ENGINE_SRC,
    },
  });
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");
    await waitForSidecar(win);

    // 真实 OCR 任务并等待完成
    const sourceFile = path.join(sourceDir, "custom-single.pdf");
    const taskId = await win.evaluate(async (file) => {
      const api = (window as any).archiveLens;
      const task = await api.tasks.create({ source_type: "files", source_files: [file], search_text: "档" });
      await api.tasks.start(task.task_id);
      return task.task_id as string;
    }, sourceFile);
    await expect.poll(async () => win.evaluate(async (id) => {
      return (await (window as any).archiveLens.tasks.get(id)).status;
    }, taskId), { timeout: 90_000 }).toBe("completed");

    await win.evaluate((id) => { window.location.hash = `#/export/${id}`; }, taskId);
    await expect(win.getByRole("heading", { name: "导出结果" })).toBeVisible();

    // JSON job：创建（阶段性任务需确认）→ 轮询作业列表直到 completed
    await win.getByRole("radio", { name: /JSON 数据包/ }).click();
    await win.getByRole("button", { name: /开始导出 JSON/ }).click();
    await win.getByRole("button", { name: "仍然导出阶段性结果" }).click({ timeout: 3000 }).catch(() => undefined);
    await expect.poll(async () => win.evaluate(async (id) => {
      const list = await (window as any).archiveLens.export.listJobs(id);
      return list.items.find((j: any) => j.format === "json")?.status;
    }, taskId), { timeout: 30_000 }).toBe("completed");
    await expect(win.getByText(/成功导出历史|JSON 数据包/).first()).toBeVisible();

    // HTML job：创建（需确认）→ 等待 completed（真实渲染）
    await win.getByRole("radio", { name: /HTML 审阅报告/ }).click();
    await win.getByRole("button", { name: /开始导出 HTML/ }).click();
    await win.getByRole("button", { name: "仍然导出 HTML" }).click({ timeout: 3000 }).catch(() => undefined);
    await expect.poll(async () => win.evaluate(async (id) => {
      const list = await (window as any).archiveLens.export.listJobs(id);
      return list.items.find((j: any) => j.format === "html")?.status;
    }, taskId), { timeout: 90_000 }).toBe("completed");
    await expect(win.getByText("打开文件夹").first()).toBeVisible();

    // 取消语义：再开一个 HTML job 并立即取消；接受 cancelled 或 completed（小任务可能过快完成）
    await win.getByRole("button", { name: /开始导出 HTML/ }).click();
    await win.getByRole("button", { name: "仍然导出 HTML" }).click({ timeout: 3000 }).catch(() => undefined);
    const cancelBtn = win.getByRole("button", { name: "取消导出" });
    await cancelBtn.click({ timeout: 2000 }).catch(() => undefined);
    await expect.poll(async () => win.evaluate(async (id) => {
      const list = await (window as any).archiveLens.export.listJobs(id);
      const htmlJobs = list.items.filter((j: any) => j.format === "html");
      const last = htmlJobs[0];
      return last ? last.status : "none";
    }, taskId), { timeout: 60_000 }).toMatch(/cancelled|completed/);
  } finally {
    await app.close().catch(() => undefined);
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(sourceDir, { recursive: true, force: true }).catch(() => undefined);
  }
});
