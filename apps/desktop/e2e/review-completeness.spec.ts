import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const APP_DIR = path.resolve(__dirname, "..");
const ROOT_DIR = path.resolve(APP_DIR, "..", "..");
const ENGINE_SRC = path.join(ROOT_DIR, "engine", "src");
const SEED_REVIEW_TASK = path.join(__dirname, "helpers", "seed-review-task.py");
const VISUAL_OUTPUT = path.join(ROOT_DIR, "output", "playwright");
const RUN_ID = (process.env["ARCHIVELENS_TEST_RUN_ID"] ?? "review-completeness").replace(/[^A-Za-z0-9._-]/g, "-");

async function resolvePythonExecutable(): Promise<string> {
  if (process.env["ARCHIVELENS_E2E_PYTHON"]) return process.env["ARCHIVELENS_E2E_PYTHON"]!;
  const versions = path.join(process.env["USERPROFILE"] ?? "", ".pyenv", "pyenv-win", "versions");
  const { readdir } = await import("node:fs/promises");
  for (const entry of (await readdir(versions, { withFileTypes: true })).filter((item) => item.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
    const candidate = path.join(versions, entry.name, "python.exe");
    try { await access(candidate); return candidate; } catch { /* continue */ }
  }
  throw new Error("无法解析可执行的 python.exe；请设置 ARCHIVELENS_E2E_PYTHON");
}

async function makeOwnedUserData(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `archivelens-e2e-userdata-${RUN_ID}-review-`));
  await writeFile(path.join(dir, ".archivelens-test-owned"), `${RUN_ID}\n`, "utf8");
  return dir;
}

async function seedReviewTask(userDataDir: string, count: number): Promise<{ taskId: string; occurrenceIds: string[] }> {
  const python = await resolvePythonExecutable();
  const result = await execFileAsync(python, [SEED_REVIEW_TASK, userDataDir, String(count)], {
    env: { ...process.env, PYTHONPATH: ENGINE_SRC, PYTHONUTF8: "1" },
  });
  return JSON.parse(result.stdout) as { taskId: string; occurrenceIds: string[] };
}

async function seedLayoutContextTask(userDataDir: string): Promise<{ taskId: string; occurrenceIds: string[] }> {
  const python = await resolvePythonExecutable();
  const result = await execFileAsync(python, [SEED_REVIEW_TASK, userDataDir, "layout"], {
    env: { ...process.env, PYTHONPATH: ENGINE_SRC, PYTHONUTF8: "1" },
  });
  return JSON.parse(result.stdout) as { taskId: string; occurrenceIds: string[] };
}

async function launchDesktop(userDataDir: string): Promise<ElectronApplication> {
  const python = await resolvePythonExecutable();
  return electron.launch({
    args: [APP_DIR],
    cwd: APP_DIR,
    env: {
      ...process.env,
      ARCHIVELENS_E2E: "1",
      ARCHIVELENS_USER_DATA_DIR: userDataDir,
      AL_DEBUG: "1",
      AL_ENGINE_DEV: python,
      AL_ENGINE_SRC: ENGINE_SRC,
      AL_SLOWFAKE_PAGES: "1",
    },
  });
}

async function openReview(app: ElectronApplication, taskId: string): Promise<Page> {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await expect.poll(async () => page.evaluate(async () => (await (window as any).archiveLens.app.getEnvironment()).sidecarReady)).toBe(true);
  const seededPage = await page.evaluate(async (id) => {
    return (window as any).archiveLens.results.query({ task_id: id, limit: 1, offset: 0 });
  }, taskId);
  expect(seededPage.total).toBeGreaterThan(0);
  await page.evaluate((id) => { window.location.hash = `#/review/${id}`; }, taskId);
  await expect(page.locator(".al-result-item").first()).toBeVisible();
  return page;
}

async function closeApp(app: ElectronApplication): Promise<void> {
  await app.close().catch(() => undefined);
}

test("E2E-00：1280px 三栏工作台、窄窗详情抽屉与菜单折叠记忆", async () => {
  const userDataDir = await makeOwnedUserData();
  const seeded = await seedReviewTask(userDataDir, 3);
  let app = await launchDesktop(userDataDir);
  try {
    let page = await openReview(app, seeded.taskId);
    await page.setViewportSize({ width: 1280, height: 760 });
    await expect(page.getByRole("heading", { name: "校对工作台" })).toHaveCount(0);
    await expect(page.locator(".al-review-summary")).toHaveCount(0);
    await expect(page.locator(".al-review-aside-toggle")).toHaveCount(0);
    await expect(page.locator(".al-review-taskbar")).toBeVisible();
    await expect(page.locator(".al-review-progress-summary")).toHaveAttribute("aria-label", "已审核 0，共 3 条");
    await expect(page.locator(".al-sequence-badge").first()).toHaveText("#0001");
    await expect(page.locator(".al-recoverable, .al-sidebar-task")).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "全局导航" })).toBeVisible();
    await expect(page.getByRole("region", { name: "当前任务工作区" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "当前任务导航" })).toBeVisible();

    const layout = await page.locator(".al-review-body").evaluate(() => {
      const rect = (selector: string) => {
        const value = document.querySelector(selector)?.getBoundingClientRect();
        return value ? { x: value.x, width: value.width } : null;
      };
      return {
        image: rect(".al-review-image-pane"),
        list: rect(".al-result-list"),
        detail: rect(".al-detail"),
        resizers: document.querySelectorAll(".al-review-resizer").length,
      };
    });
    expect(layout.image).not.toBeNull();
    expect(layout.list).not.toBeNull();
    expect(layout.detail).not.toBeNull();
    expect(layout.image!.x).toBeLessThan(layout.list!.x);
    expect(layout.list!.x).toBeLessThan(layout.detail!.x);
    expect(layout.image!.width).toBeGreaterThan(layout.list!.width);
    expect(layout.list!.width).toBeGreaterThanOrEqual(240);
    expect(layout.detail!.width).toBeGreaterThanOrEqual(260);
    expect(layout.resizers).toBe(2);
    const layoutContextLine = page.locator(".al-layout-context-line").first();
    await expect(layoutContextLine).toContainText("档案");
    await expect(layoutContextLine).toHaveCSS("white-space", "pre");
    await expect(page.getByRole("alert")).toHaveText("任务缺少扫描工作目录，请重新扫描");

    const sidebar = page.locator(".al-sidebar");
    await expect(sidebar).toHaveCSS("width", "64px");
    await expect(page.getByRole("link", { name: "首页" })).toHaveAttribute("title", "首页");
    await page.getByRole("button", { name: "展开菜单" }).click();
    await expect(sidebar).toHaveCSS("width", "228px");

    await page.setViewportSize({ width: 1080, height: 760 });
    const detailDrawer = page.locator(".al-detail");
    const detailDrawerTrigger = page.getByRole("button", { name: "查看详情" });
    await expect(page.locator(".al-review-resizer:visible")).toHaveCount(0);
    await expect(detailDrawerTrigger).toBeVisible();
    await expect(detailDrawer).not.toHaveClass(/drawer-open/);
    await expect(detailDrawer).toHaveAttribute("aria-hidden", "true");
    await expect.poll(async () => detailDrawer.evaluate((element) => (element as HTMLElement).inert)).toBe(true);
    await detailDrawerTrigger.click();
    await expect(detailDrawer).toHaveClass(/drawer-open/);
    await expect(detailDrawer).toHaveAttribute("role", "dialog");
    await expect(detailDrawer).toHaveAttribute("aria-modal", "true");
    await expect(page.getByRole("button", { name: "关闭", exact: true })).toBeFocused();
    await expect.poll(async () => page.locator(".al-detail").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.right - document.documentElement.clientWidth;
    })).toBeLessThanOrEqual(1);
    const drawer = await page.locator(".al-detail").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width, viewportWidth: document.documentElement.clientWidth };
    });
    expect(drawer.left).toBeGreaterThanOrEqual(0);
    expect(drawer.right).toBeLessThanOrEqual(drawer.viewportWidth + 1);
    expect(drawer.width).toBeGreaterThanOrEqual(320);
    await mkdir(VISUAL_OUTPUT, { recursive: true });
    await page.screenshot({ path: path.join(VISUAL_OUTPUT, "phase3-detail-drawer-1080.png") });
    await page.keyboard.press("Shift+Tab");
    await expect(detailDrawer.locator(".al-navigation-actions button").last()).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "关闭", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(detailDrawer).not.toHaveClass(/drawer-open/);
    await expect(detailDrawer).toHaveAttribute("aria-hidden", "true");
    await expect(detailDrawerTrigger).toBeFocused();

    await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "active" });
    const forcedOutline = await page.locator(".al-result-item.current").evaluate((element) => ({
      style: getComputedStyle(element).outlineStyle,
      width: Number.parseFloat(getComputedStyle(element).outlineWidth),
    }));
    expect(forcedOutline.style).toBe("solid");
    expect(forcedOutline.width).toBeGreaterThanOrEqual(1.5);
    const reducedTransitionSeconds = await page.locator(".al-review-progress-track span").evaluate((element) => (
      Number.parseFloat(getComputedStyle(element).transitionDuration)
    ));
    expect(reducedTransitionSeconds).toBeLessThanOrEqual(0.001);
    await page.emulateMedia({ reducedMotion: "no-preference", forcedColors: "none" });

    await page.getByRole("link", { name: "任务中心" }).click();
    await expect(page.getByRole("table", { name: "全部任务" })).toBeVisible();
    const taskCenterGeometry = await page.locator(".al-task-center-table").evaluate((element) => {
      const row = element.querySelector<HTMLElement>(".al-task-table-row");
      return {
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        rowRadius: row ? getComputedStyle(row).borderRadius : "",
        rowColumns: row ? getComputedStyle(row).gridTemplateColumns : "",
      };
    });
    expect(taskCenterGeometry.scrollWidth).toBeLessThanOrEqual(taskCenterGeometry.clientWidth + 1);
    expect(taskCenterGeometry.rowRadius).toBe("12px");
    expect(taskCenterGeometry.rowColumns.split(" ").length).toBe(3);
    await mkdir(VISUAL_OUTPUT, { recursive: true });
    await page.screenshot({ path: path.join(VISUAL_OUTPUT, "phase2-task-center-1080.png") });
    await closeApp(app);

    app = await launchDesktop(userDataDir);
    page = await openReview(app, seeded.taskId);
    await expect(page.locator(".al-sidebar")).toHaveCSS("width", "228px");
    await expect(page.getByRole("button", { name: "收起菜单" })).toHaveAttribute("aria-expanded", "true");
  } finally {
    await closeApp(app);
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("E2E-LAYOUT：#0001 使用同版块竖排三列并支持按页修正", async () => {
  const userDataDir = await makeOwnedUserData();
  let app: ElectronApplication | null = null;
  try {
    const seeded = await seedLayoutContextTask(userDataDir);
    app = await launchDesktop(userDataDir);
    const page = await openReview(app, seeded.taskId);
    await page.setViewportSize({ width: 1440, height: 900 });
    const contextLines = page.locator(".al-layout-context-line");
    await expect(contextLines).toHaveCount(3);
    await expect(page.locator(".al-layout-context-heading")).toContainText("版面 OCR 上下文");
    await expect(page.locator(".al-layout-context-heading")).toContainText("命中列及相邻两列");
    await expect(page.locator(".al-page-evidence-sequence")).toHaveText("当前 #0001");
    await expect(page.locator(".al-page-canvas .al-page-evidence-sequence")).toHaveCount(0);
    await expect(page.locator(".al-layout-context-line.target mark")).toHaveText("虧空");
    await expect(contextLines.nth(0)).toHaveText("即位以來軫念伊等生計艱難頻頒賞賚優卹備");
    await expect(contextLines.nth(1)).toHaveText("至其虧空錢粮已令該部查奏寬免其入官之墳");
    await expect(contextLines.nth(2)).toHaveText("塋地已令查明給還其因獲罪草進之世職亦");
    const geometry = await page.locator(".al-layout-context-viewport").evaluate((viewport) => {
      const lines = [...viewport.querySelectorAll<HTMLElement>(".al-layout-context-line")];
      return {
        overflowY: getComputedStyle(viewport).overflowY,
        writingModes: lines.map((line) => getComputedStyle(line).writingMode),
        left: lines.map((line) => line.offsetLeft),
        targetMarkCount: lines[1]?.querySelectorAll("mark").length ?? 0,
      };
    });
    expect(geometry.overflowY).toBe("auto");
    expect(geometry.writingModes).toEqual(["vertical-rl", "vertical-rl", "vertical-rl"]);
    expect(geometry.left[0]).toBeGreaterThan(geometry.left[1]);
    expect(geometry.left[1]).toBeGreaterThan(geometry.left[2]);
    expect(geometry.targetMarkCount).toBe(1);
    await expect(page.locator(".al-page-canvas img")).toBeVisible();
    await expect.poll(async () => page.locator(".al-page-canvas img").evaluate((image) => (
      (image as HTMLImageElement).naturalWidth
    ))).toBeGreaterThan(0);
    await mkdir(VISUAL_OUTPUT, { recursive: true });
    await page.screenshot({ path: path.join(VISUAL_OUTPUT, "layout-context-0001.png") });

    await page.getByRole("button", { name: "修正版面" }).click();
    await expect(page.locator(".al-layout-correction-panel")).toBeVisible();
    await expect(page.locator(".al-layout-candidate-block.contains-target").first()).toBeVisible();
    await page.locator(".al-layout-candidate-block.contains-target").first().click();
    await expect(page.locator(".al-layout-context-line.target mark")).toHaveText("虧空");
    await page.screenshot({ path: path.join(VISUAL_OUTPUT, "layout-context-correction-preview.png") });
    await page.getByRole("button", { name: "保存到本页" }).click();
    await expect(page.locator(".al-layout-correction-panel")).toHaveCount(0);
    const saved = await page.evaluate(async ({ taskId, occurrenceId }) => (
      (window as any).archiveLens.review.getLayoutContext({ task_id: taskId, occurrence_id: occurrenceId })
    ), { taskId: seeded.taskId, occurrenceId: seeded.occurrenceIds[0] });
    expect(saved.context.has_page_override).toBe(true);
    expect(saved.context.items.map((item: { line_index: number }) => item.line_index)).toEqual([2, 1, 0]);
  } finally {
    if (app) await closeApp(app);
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("E2E-01：201 条结果可虚拟访问、保持页面视图并批量撤销", async () => {
  const userDataDir = await makeOwnedUserData();
  const seeded = await seedReviewTask(userDataDir, 201);
  const app = await launchDesktop(userDataDir);
  try {
    const page = await openReview(app, seeded.taskId);
    await expect(page.locator(".al-result-item").first()).toBeVisible();
    expect(await page.locator(".al-result-item").count()).toBeLessThan(30);

    const jump = page.getByRole("textbox", { name: "跳转到筛选结果位置" });
    await jump.fill("201");
    await page.getByRole("button", { name: "跳转" }).click();
    await expect(page.locator(`[data-occurrence-id="${seeded.occurrenceIds[200]}"]`)).toBeVisible();
    await jump.fill("1");
    await page.getByRole("button", { name: "跳转" }).click();
    await expect(page.locator(`[data-occurrence-id="${seeded.occurrenceIds[0]}"]`)).toBeVisible();

    await expect(page.locator(".al-zoom-value")).toHaveText("100%");
    await page.getByRole("button", { name: "放大页面" }).click();
    await expect(page.locator(".al-zoom-value")).toHaveText("125%");
    await page.locator(`[data-occurrence-id="${seeded.occurrenceIds[1]}"]`).click();
    await expect(page.locator(".al-zoom-value")).toHaveText("125%");
    await page.locator(`[data-occurrence-id="${seeded.occurrenceIds[4]}"]`).click();
    await expect(page.locator(".al-zoom-value")).toHaveText("100%");
    await page.getByRole("button", { name: "页面朝右（90°）" }).click();
    await expect(page.getByRole("button", { name: "页面朝右（90°）" })).toHaveAttribute("aria-pressed", "true");
    await page.locator(`[data-occurrence-id="${seeded.occurrenceIds[5]}"]`).click();
    await expect(page.getByRole("button", { name: "页面朝右（90°）" })).toHaveAttribute("aria-pressed", "true");

    await jump.fill("101");
    await page.getByRole("button", { name: "跳转" }).click();
    await expect(page.locator(`[data-occurrence-id="${seeded.occurrenceIds[100]}"]`)).toBeVisible();
    await expect(page.getByRole("button", { name: "页面朝上（0°）" })).toHaveAttribute("aria-pressed", "true");

    await jump.fill("1");
    await page.getByRole("button", { name: "跳转" }).click();
    await page.getByRole("button", { name: "批量选择" }).click();
    await page.locator(`[data-occurrence-id="${seeded.occurrenceIds[0]}"]`).click();
    await page.locator(`[data-occurrence-id="${seeded.occurrenceIds[3]}"]`).click({ modifiers: ["Shift"] });
    await expect(page.locator(".al-review-batchbar")).toContainText("已选 4 条");
    await page.getByRole("button", { name: "批量确认" }).click();
    await expect(page.locator(".al-review-progress-summary")).toHaveAttribute("aria-label", "已审核 4，共 201 条");
    await page.getByRole("button", { name: "撤销" }).click();
    await expect(page.locator(".al-review-progress-summary")).toHaveAttribute("aria-label", "已审核 0，共 201 条");
  } finally {
    await closeApp(app);
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("E2E-02：1000 条虚拟跳转、保存后前进、撤销重做与导出集合一致", async () => {
  const userDataDir = await makeOwnedUserData();
  const seeded = await seedReviewTask(userDataDir, 1000);
  let app = await launchDesktop(userDataDir);
  try {
    let page = await openReview(app, seeded.taskId);
    const searchBox = page.getByRole("textbox", { name: "搜索结果上下文" });
    await searchBox.pressSequentially("asdjknf");
    const reviewedAfterTyping = await page.evaluate(async (taskId) => {
      const result = await (window as any).archiveLens.results.query({ task_id: taskId, limit: 1, offset: 0 });
      return result.review_summary.reviewed_count as number;
    }, seeded.taskId);
    expect(reviewedAfterTyping).toBe(0);
    await searchBox.fill("");
    await expect(page.locator(".al-result-item").first()).toBeVisible();

    const jump = page.getByRole("textbox", { name: "跳转到筛选结果位置" });
    for (const position of [1, 100, 101, 500, 1000]) {
      await jump.fill(String(position));
      await page.getByRole("button", { name: "跳转" }).click();
      await expect(page.locator(`[data-occurrence-id="${seeded.occurrenceIds[position - 1]}"]`)).toBeVisible();
    }

    await jump.fill("1");
    await page.getByRole("button", { name: "跳转" }).click();
    await page.locator(".al-note-summary").click();
    await page.getByRole("textbox", { name: "校对备注" }).fill("自动保存备注：重启后仍应存在");
    await expect(page.locator(".al-save-state")).toHaveText("已保存");
    await page.getByRole("button", { name: "确认 A" }).click();
    await expect(page.locator(`[data-occurrence-id="${seeded.occurrenceIds[1]}"]`)).toHaveAttribute("aria-current", "true");
    await expect(page.locator(".al-review-progress-summary")).toHaveAttribute("aria-label", "已审核 1，共 1000 条");
    await page.getByRole("button", { name: "撤销" }).click();
    await expect(page.locator(".al-review-progress-summary")).toHaveAttribute("aria-label", "已审核 0，共 1000 条");
    await page.getByRole("button", { name: "重做" }).click();
    await expect(page.locator(".al-review-progress-summary")).toHaveAttribute("aria-label", "已审核 1，共 1000 条");
    await page.getByRole("button", { name: "下一条待处理 N" }).click();
    await page.getByRole("button", { name: "待复核 S" }).click();
    await expect(page.locator(".al-review-progress-summary")).toHaveAttribute("aria-label", "已审核 2，共 1000 条");

    const exportPath = await page.evaluate(async (taskId) => {
      return (await (window as any).archiveLens.export.json(taskId)).path as string;
    }, seeded.taskId);
    const exportPayload = JSON.parse(await readFile(exportPath, "utf8"));
    expect(exportPayload.occurrences.map((item: { occurrence_id: string }) => item.occurrence_id)).toEqual(seeded.occurrenceIds);
    expect(exportPayload.integrity).toMatchObject({ total_occurrences: 1000, exported_occurrences: 1000, reviewed_count: 2, unreviewed_count: 998, review_complete: false, export_complete: true, fully_verified: false });

    await closeApp(app);
    app = await launchDesktop(userDataDir);
    page = await openReview(app, seeded.taskId);
    const afterRestart = await page.evaluate(async (taskId) => {
      return (window as any).archiveLens.results.query({ task_id: taskId, limit: 200, offset: 0 });
    }, seeded.taskId);
    expect(afterRestart.review_summary).toMatchObject({ reviewed_count: 2, unreviewed_count: 998, confirmed_count: 1, needs_review_count: 1 });
    expect(afterRestart.items[0].review_note).toBe("自动保存备注：重启后仍应存在");
  } finally {
    await closeApp(app);
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("E2E-03：全局高亮、任务覆盖与恢复跟随在重启后保持一致", async () => {
  const userDataDir = await makeOwnedUserData();
  const seeded = await seedReviewTask(userDataDir, 1);
  const seededTaskData = path.join(userDataDir, "engine", "tasks", seeded.taskId, "scan", "e2e-derived.bin");
  await mkdir(path.dirname(seededTaskData), { recursive: true });
  await writeFile(seededTaskData, "isolated-e2e-derived-data", "utf8");
  let app = await launchDesktop(userDataDir);
  try {
    let page = await openReview(app, seeded.taskId);
    await page.getByRole("button", { name: "页面朝右（90°）" }).click();
    await expect(page.getByRole("button", { name: "页面朝右（90°）" })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("link", { name: "设置" }).click();
    await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
    await expect(page.getByText("本地处理不等于应用级加密")).toBeVisible();
    await expect(page.getByText("当前可读数据合计")).toBeVisible();
    await expect(page.getByText("查看各任务占用（1）")).toBeVisible();

    await page.getByRole("button", { name: "更改标记待复核快捷键" }).click();
    const needsReviewCapture = page.getByRole("button", { name: "正在设置标记待复核，请按新键" });
    await needsReviewCapture.press("a");
    await expect(page.getByRole("alert")).toContainText("A 已用于“确认命中”");
    await needsReviewCapture.press("Escape");
    await expect(page.getByRole("button", { name: "更改标记待复核快捷键" })).toBeVisible();

    await page.getByRole("button", { name: "更改确认命中快捷键" }).click();
    await page.getByRole("button", { name: "正在设置确认命中，请按新键" }).press("q");
    await expect(page.getByText("快捷键已保存在本机，重新进入校对页后立即生效。")).toBeVisible();
    await mkdir(VISUAL_OUTPUT, { recursive: true });
    await page.screenshot({ path: path.join(VISUAL_OUTPUT, "phase2-shortcut-settings.png") });
    await page.getByRole("link", { name: "校对" }).click();
    await expect(page.getByRole("button", { name: "确认 Q" })).toBeVisible();
    await page.locator(".al-review-image-pane").click({ position: { x: 24, y: 24 } });
    await page.keyboard.press("a");
    expect(await page.evaluate(async (taskId) => (
      await (window as any).archiveLens.results.query({ task_id: taskId, limit: 1, offset: 0 })
    ).review_summary.reviewed_count, seeded.taskId)).toBe(0);
    await page.keyboard.press("q");
    await expect(page.locator(".al-review-progress-summary")).toHaveAttribute("aria-label", "已审核 1，共 1 条");
    await page.getByRole("link", { name: "设置" }).click();

    await page.getByRole("button", { name: "清理安全临时残留", exact: true }).click();
    await expect(page.getByRole("button", { name: "确认清理安全临时残留" })).toBeVisible();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.getByRole("button", { name: "清理安全临时残留", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "环境诊断" })).toHaveCount(0);
    await page.getByRole("button", { name: "打开环境诊断" }).click();
    await expect(page.getByRole("heading", { name: "环境诊断" })).toBeVisible();
    await expect(page.getByRole("link", { name: "设置" })).toHaveClass(/active/);
    await page.getByRole("link", { name: "设置" }).click();
    await page.getByRole("tab", { name: "全局默认" }).click();
    await page.getByRole("button", { name: "淡蓝" }).click();
    await expect(page.getByRole("status").filter({ hasText: "已保存" })).toBeVisible();
    await page.getByRole("link", { name: "校对" }).click();
    await expect.poll(async () => page.locator(".al-review").evaluate((element) => (element as HTMLElement).style.getPropertyValue("--al-review-highlight"))).toBe("rgba(39, 139, 199, 0.18)");

    await page.getByRole("link", { name: "设置" }).click();
    await page.getByRole("tab", { name: "指定任务" }).click();
    await expect(page.getByLabel("选择任务")).toHaveValue(seeded.taskId);
    await page.getByRole("button", { name: "淡紫" }).click();
    await page.getByRole("link", { name: "校对" }).click();
    await expect.poll(async () => page.locator(".al-review").evaluate((element) => (element as HTMLElement).style.getPropertyValue("--al-review-highlight"))).toBe("rgba(140, 98, 184, 0.18)");

    await closeApp(app);
    app = await launchDesktop(userDataDir);
    page = await openReview(app, seeded.taskId);
    await expect(page.getByRole("button", { name: "页面朝右（90°）" })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => page.locator(".al-review").evaluate((element) => (element as HTMLElement).style.getPropertyValue("--al-review-highlight"))).toBe("rgba(140, 98, 184, 0.18)");

    await page.getByRole("link", { name: "设置" }).click();
    await page.getByRole("tab", { name: "指定任务" }).click();
    await page.getByRole("button", { name: "恢复跟随全局", exact: true }).click();
    await page.getByRole("link", { name: "校对" }).click();
    await expect.poll(async () => page.locator(".al-review").evaluate((element) => (element as HTMLElement).style.getPropertyValue("--al-review-highlight"))).toBe("rgba(39, 139, 199, 0.18)");
  } finally {
    await closeApp(app);
    await rm(userDataDir, { recursive: true, force: true });
  }
});
