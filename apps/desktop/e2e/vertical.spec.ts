import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let app: ElectronApplication;
let win: Page;
let userDataDir: string;

test.beforeAll(async () => {
  const exe = path.resolve(__dirname, "..", "release", "win-unpacked", "ArchiveLens.exe");
  userDataDir = await mkdtemp(path.join(os.tmpdir(), "archivelens-vertical-e2e-"));
  app = await electron.launch({
    executablePath: exe,
    env: {
      ...process.env,
      AL_DEBUG: "1",
      ARCHIVELENS_USER_DATA_DIR: userDataDir,
    },
  });
  win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  try {
    await app?.close();
  } catch {
    // 忽略
  }
  if (userDataDir) {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("E2E-1 应用启动与欢迎页", async () => {
  await expect(win.getByText("欢迎使用 ArchiveLens")).toBeVisible({ timeout: 30_000 });
  // 无 pageerror
  const errors: string[] = [];
  win.on("pageerror", (e) => errors.push(String(e)));
  await win.waitForTimeout(1000);
  expect(errors.join("")).toBe("");
});

test("E2E-2 体验示例进入校对工作台", async () => {
  await win.getByText("体验示例").click();
  await win.waitForURL(/#\/review\//, { timeout: 45_000 });
  await expect(win.locator(".al-result-item").first()).toBeVisible({ timeout: 30_000 });
  const count = await win.locator(".al-result-item").count();
  expect(count).toBeGreaterThanOrEqual(6);
  // 出处页图片加载
  await expect(win.locator(".al-page-wrap img").first()).toBeVisible();
});

test("E2E-3 校对状态修改与持久化", async () => {
  await win.locator(".al-result-item").first().click();
  await win.getByRole("button", { name: "确认命中 (A)" }).click();
  await expect(win.locator(".al-review-summary")).toContainText("已确认 1");
  // 重载验证持久化（SQLite）
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.locator(".al-result-item").first()).toBeVisible({ timeout: 30_000 });
  await expect(win.locator(".al-review-summary")).toContainText("已确认 1");
});

test("E2E-4 导出中心生成 HTML 并保持应用可用", async () => {
  await win.getByRole("button", { name: "前往导出中心" }).click();
  await win.waitForURL(/#\/export\//);
  await expect(win.getByRole("heading", { name: "导出结果" })).toBeVisible();
  await win.getByRole("radio", { name: /HTML 审阅报告/ }).click();
  await win.getByRole("button", { name: "导出 HTML" }).click();
  await win.getByRole("button", { name: "仍然导出 HTML" }).click();
  await expect(win.getByText(/已导出 \d+ 条结果至/)).toBeVisible({ timeout: 60_000 });
  await expect(win.getByText("本次导出：已完成")).toBeVisible();
});
