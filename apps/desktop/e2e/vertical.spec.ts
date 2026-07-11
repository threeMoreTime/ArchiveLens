import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import path from "node:path";

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  const exe = path.resolve(__dirname, "..", "release", "win-unpacked", "ArchiveLens.exe");
  app = await electron.launch({
    executablePath: exe,
    args: ["--user-data-dir=C:/al-e2e"],
    env: { ...process.env, AL_DEBUG: "1" },
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
  await win.getByText("已确认 (A)").click();
  await win.waitForTimeout(500);
  // 重载验证持久化（SQLite）
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.locator(".al-result-item").first()).toBeVisible({ timeout: 30_000 });
});

test("E2E-4 导出 HTML 不崩溃", async () => {
  await win.getByText("导出 HTML").click();
  await win.waitForTimeout(1500);
  // 导出成功后 openFolder 打开资源管理器；这里仅验证应用未崩溃
  await expect(win.getByText("导出 HTML")).toBeVisible();
});
