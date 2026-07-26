import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { access, copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "os";
import path from "path";

const APP_DIR = path.resolve(__dirname, "..");
const ROOT_DIR = path.resolve(APP_DIR, "..", "..");
const ENGINE_SRC = path.join(ROOT_DIR, "engine", "src");
const FIXTURE = path.join(ROOT_DIR, "tests", "fixtures", "ocr", "custom-single.pdf");
const RUN_ID = (process.env["ARCHIVELENS_TEST_RUN_ID"] ?? "a11-local").replace(/[^A-Za-z0-9._-]/g, "-");

async function resolvePythonExecutable(): Promise<string> {
  const explicit = process.env["ARCHIVELENS_E2E_PYTHON"];
  if (explicit) { await access(explicit); return explicit; }
  const userProfile = process.env["USERPROFILE"];
  if (userProfile) {
    const versionsRoot = path.join(userProfile, ".pyenv", "pyenv-win", "versions");
    const { readdir } = await import("node:fs/promises");
    const candidates = (await readdir(versionsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(versionsRoot, entry.name, "python.exe"))
      .sort().reverse();
    for (const candidate of candidates) {
      try { await access(candidate); return candidate; } catch { /* continue */ }
    }
  }
  throw new Error("无法解析 python.exe；请设置 ARCHIVELENS_E2E_PYTHON");
}

async function waitForSidecar(page: Page): Promise<void> {
  await expect.poll(async () => page.evaluate(async () => {
    const env = await (window as any).archiveLens.app.getEnvironment();
    return Boolean(env?.sidecarReady);
  })).toBe(true);
}

test("P1-1：检索页在扫描完成后自动刷新语料为 ready，无需重新进入页面", async () => {
  const runRoot = await mkdtemp(path.join(os.tmpdir(), `archivelens-search-corpus-${RUN_ID}-`));
  const userDataDir = path.join(runRoot, "user-data");
  const sourceDir = path.join(runRoot, "source");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(sourceDir, { recursive: true });
  await writeFile(path.join(runRoot, ".archivelens-test-owned"), `${RUN_ID}\n`, "utf8");
  await copyFile(FIXTURE, path.join(sourceDir, "custom-single.pdf"));

  let app: ElectronApplication | null = null;
  try {
    const pythonExe = await resolvePythonExecutable();
    app = await electron.launch({
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
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.setViewportSize({ width: 1280, height: 760 });
    await waitForSidecar(page);

    // 创建并启动任务（语料开始建立）
    const sourceFile = path.join(sourceDir, "custom-single.pdf");
    const taskId = await page.evaluate(async (file) => {
      const api = (window as any).archiveLens;
      const task = await api.tasks.create({ source_type: "files", source_files: [file], search_text: "档" });
      await api.tasks.start(task.task_id);
      return task.task_id as string;
    }, sourceFile);

    // 立即进入检索页：此时任务仍在扫描，语料应为 not_built/building（非 ready）。
    await page.evaluate((id) => { window.location.hash = `#/search/${id}`; }, taskId);
    await expect(page.getByText(/语料：/)).toBeVisible({ timeout: 10_000 });

    // 等待扫描完成（task.completed 事件触发 corpus 自动刷新）
    await expect.poll(async () => page.evaluate(async (id) => {
      return (await (window as any).archiveLens.tasks.get(id)).status;
    }, taskId), { timeout: 120_000 }).toBe("completed");

    // 关键断言：停留在检索页，语料状态自动变为 ready 或 partial（无需重新进入）。
    // 覆盖"用户在 task.completed 事件发出后才进入检索页、错过事件"的时序：
    // 兜底轮询在 corpus 处于中间态时持续刷新，直到语料就绪。
    await expect.poll(async () => page.locator(".al-search-summary").textContent(), { timeout: 60_000 })
      .toMatch(/完整可检索|可检索但尚未完整/);
    await expect(page.getByRole("button", { name: /检索/ }).first()).toBeEnabled();

    // 实际执行一次检索，验证 ready 语料可搜索
    await page.getByRole("textbox", { name: "任务内检索文字或词语" }).fill("档");
    await page.getByRole("button", { name: /检索/ }).first().click();
    await expect.poll(async () => page.evaluate(async (id) => {
      const api = (window as any).archiveLens;
      const sessions = await api.search.listSessions(id, 10);
      return sessions.items.length > 0;
    }, taskId), { timeout: 30_000 }).toBe(true);
  } finally {
    await app?.close().catch(() => undefined);
    await rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});
