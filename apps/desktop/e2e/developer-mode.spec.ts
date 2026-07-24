import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const APP_DIR = path.resolve(__dirname, "..");
const ROOT_DIR = path.resolve(APP_DIR, "..", "..");
const VISUAL_OUTPUT = path.join(ROOT_DIR, "output", "playwright");
const RUN_ID = (process.env["ARCHIVELENS_TEST_RUN_ID"] ?? "dev-local").replace(/[^A-Za-z0-9._-]/g, "-");

async function launch(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [APP_DIR],
    cwd: APP_DIR,
    env: {
      ...process.env,
      ARCHIVELENS_E2E: "1",
      ARCHIVELENS_USER_DATA_DIR: userDataDir,
      AL_DEBUG: "1",
    },
  });
}

/** 3 秒内连续激活版本按钮 7 次解锁开发者模式（键盘 Enter 与鼠标点击等价）。 */
async function unlockDeveloperMode(page: Page): Promise<void> {
  const versionButton = page.getByRole("button", { name: /ArchiveLens 0/ });
  const status = page.locator("#al-developer-trigger-status");
  await versionButton.focus();
  for (let index = 1; index <= 4; index += 1) await page.keyboard.press("Enter");
  await expect(status).toHaveText("");
  await page.keyboard.press("Enter");
  await expect(status).toHaveText("再点击 2 次进入开发者模式");
  await page.keyboard.press("Enter");
  await expect(status).toHaveText("再点击 1 次进入开发者模式");
  await page.keyboard.press("Enter");
  await expect(status).toHaveText("已进入开发者模式");
}

test("developer mode unlocks, gates sensitive IPC, and renders the developer page", async () => {
  await mkdir(VISUAL_OUTPUT, { recursive: true });
  const runRoot = await mkdtemp(path.join(os.tmpdir(), `archivelens-dev-${RUN_ID}-`));
  const userDataDir = path.join(runRoot, "user-data");

  let app: ElectronApplication | null = null;
  let clipboardBackup = "";
  try {
    app = await launch(userDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    // 操作系统剪贴板：先保存原内容，finally 中恢复。
    clipboardBackup = await app.evaluate(({ clipboard }) => clipboard.readText());

    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    // 锁定态：直接访问 /settings/developer 会被重定向回 /settings。
    await page.evaluate(() => { window.location.hash = "#/settings/developer"; });
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("#/settings");
    await expect(page.getByRole("button", { name: "打开开发者页面" })).toHaveCount(0);

    // 锁定态下受限 IPC 必须被 Main 拒绝。
    const lockedSnapshot = await page.evaluate(async () => {
      try {
        await (window as unknown as { archiveLens: { app: { getDeveloperSnapshot: () => Promise<unknown> } } }).archiveLens.app.getDeveloperSnapshot();
        return "resolved";
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(lockedSnapshot).toContain("开发者模式未开启");

    // 隐藏入口解锁。
    await unlockDeveloperMode(page);
    const developerEntry = page.getByRole("button", { name: "打开开发者页面" });
    await expect(developerEntry).toBeVisible();
    await developerEntry.click();
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("#/settings/developer");
    await expect(page.getByText("组件与能力检查")).toBeVisible();
    await expect(page.getByText("构建与运行时")).toBeVisible();

    // 原始 JSON 默认折叠。
    const rawDetails = page.locator("details.al-developer-raw");
    await expect(rawDetails).toHaveJSProperty("open", false);

    // 1280×820 与 1080×680 视觉验收截图。
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 820));
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(VISUAL_OUTPUT, "developer-1280x820.png") });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1080, 680));
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(VISUAL_OUTPUT, "developer-1080x680.png") });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 820));

    // AI 调试确认框：列出敏感内容且声明仅写入本机剪贴板。
    await page.getByRole("button", { name: "复制 AI 错误调试信息" }).click();
    const aiDialog = page.getByRole("dialog");
    await expect(aiDialog).toContainText("复制完整 AI 错误调试信息？");
    await expect(aiDialog).toContainText("OCR 正文");
    await expect(aiDialog).toContainText("最近 300 行日志");
    await expect(aiDialog).toContainText("不会自动发送");
    await page.screenshot({ path: path.join(VISUAL_OUTPUT, "developer-ai-copy-confirm.png") });
    await aiDialog.getByRole("button", { name: "取消" }).click();

    // 脱敏诊断摘要复制：不含用户名。
    await page.getByRole("button", { name: "复制诊断摘要", exact: true }).click();
    await expect(page.getByText(/已复制到本机剪贴板/)).toBeVisible();
    const redacted = await app.evaluate(({ clipboard }) => clipboard.readText());
    expect(redacted).toContain("ArchiveLens 诊断摘要（脱敏）");
    expect(redacted).not.toContain(os.userInfo().username);

    // DevTools 按钮打开当前 Renderer 的开发者工具窗口。
    await page.getByRole("button", { name: "打开渲染器开发者工具" }).click();
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.isDevToolsOpened() ?? false)).toBe(true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.closeDevTools());

    // 退出开发者模式：返回设置、入口消失、门禁立即恢复。
    await page.getByRole("button", { name: "退出开发者模式" }).click();
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("#/settings");
    await expect(page.getByRole("button", { name: "打开开发者页面" })).toHaveCount(0);
    const afterExit = await page.evaluate(async () => {
      try {
        await (window as unknown as { archiveLens: { app: { openRendererDevTools: () => Promise<unknown> } } }).archiveLens.app.openRendererDevTools();
        return "resolved";
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(afterExit).toContain("开发者模式未开启");

    expect(pageErrors).toEqual([]);
  } finally {
    if (app) {
      await app.evaluate(({ clipboard }, backup) => clipboard.writeText(backup), clipboardBackup).catch(() => undefined);
      await app.close().catch(() => undefined);
    }
    await rm(runRoot, { recursive: true, force: true });
  }
});

test("developer mode persists across application restart", async () => {
  const runRoot = await mkdtemp(path.join(os.tmpdir(), `archivelens-dev-restart-${RUN_ID}-`));
  const userDataDir = path.join(runRoot, "user-data");

  let clipboardBackup = "";
  let first: ElectronApplication | null = null;
  try {
    first = await launch(userDataDir);
    const firstPage = await first.firstWindow();
    await firstPage.waitForLoadState("domcontentloaded");
    clipboardBackup = await first.evaluate(({ clipboard }) => clipboard.readText());
    await firstPage.evaluate(() => { window.location.hash = "#/settings"; });
    await unlockDeveloperMode(firstPage);
    await expect(firstPage.getByRole("button", { name: "打开开发者页面" })).toBeVisible();
    await first.evaluate(({ clipboard }, backup) => clipboard.writeText(backup), clipboardBackup).catch(() => undefined);
    await first.close();
    first = null;

    const second = await launch(userDataDir);
    try {
      const secondPage = await second.firstWindow();
      await secondPage.waitForLoadState("domcontentloaded");
      await secondPage.evaluate(() => { window.location.hash = "#/settings"; });
      await expect(secondPage.getByRole("button", { name: "打开开发者页面" })).toBeVisible();
      const enabled = await secondPage.evaluate(async () => (
        await (window as unknown as { archiveLens: { settings: { getDeveloperMode: () => Promise<{ enabled: boolean }> } } }).archiveLens.settings.getDeveloperMode()
      ).enabled);
      expect(enabled).toBe(true);
    } finally {
      await second.close().catch(() => undefined);
    }
  } finally {
    if (first) await first.close().catch(() => undefined);
    await rm(runRoot, { recursive: true, force: true });
  }
});
