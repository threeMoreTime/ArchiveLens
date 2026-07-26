import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";


const APP_DIR = path.resolve(__dirname, "..");
const ROOT_DIR = path.resolve(APP_DIR, "..", "..");
const ENGINE_SRC = path.join(ROOT_DIR, "engine", "src");
const SOURCE_FIXTURE = path.join(ROOT_DIR, "tests", "fixtures", "offline-formats", "simplified-horizontal.png");
const execFileAsync = promisify(execFile);


async function resolvePythonExecutable(): Promise<string> {
  const explicit = process.env["ARCHIVELENS_E2E_PYTHON"];
  if (explicit) {
    await access(explicit);
    return explicit;
  }
  const userProfile = process.env["USERPROFILE"];
  if (userProfile) {
    const versionsRoot = path.join(userProfile, ".pyenv", "pyenv-win", "versions");
    try {
      const candidates = (await readdir(versionsRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(versionsRoot, entry.name, "python.exe"))
        .sort()
        .reverse();
      for (const candidate of candidates) {
        try {
          await access(candidate);
          return candidate;
        } catch {
          // Continue to the next installed interpreter.
        }
      }
    } catch {
      // Fall through to the actionable error below.
    }
  }
  throw new Error("无法解析可执行的 python.exe；请设置 ARCHIVELENS_E2E_PYTHON");
}


async function waitForSidecar(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(async () => {
    const environment = await (window as any).archiveLens.app.getEnvironment();
    return environment.sidecarReady;
  })).toBe(true);
}


async function openTaskCenter(page: Page): Promise<void> {
  await page.evaluate(() => { window.location.hash = "#/tasks"; });
  await expect(page.getByRole("table", { name: "全部任务" })).toBeVisible();
}


test("task center batches revalidate, continue after failure, and retry safely", async () => {
  const runRoot = await mkdtemp(path.join(os.tmpdir(), "archivelens-task-batch-"));
  const userDataDir = path.join(runRoot, "user-data");
  const sourceDir = path.join(runRoot, "source");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(sourceDir, { recursive: true });
  await writeFile(path.join(runRoot, ".archivelens-test-owned"), "task-center-batch\n", "utf8");
  const sourceFile = path.join(sourceDir, "original-source.png");
  await copyFile(SOURCE_FIXTURE, sourceFile);

  let app: ElectronApplication | null = null;
  try {
    const python = await resolvePythonExecutable();
    app = await electron.launch({
      args: [APP_DIR],
      cwd: APP_DIR,
      env: {
        ...process.env,
        ARCHIVELENS_E2E: "1",
        ARCHIVELENS_USER_DATA_DIR: userDataDir,
        AL_DEBUG: "1",
        AL_ENGINE_DEV: python,
        AL_ENGINE_SRC: ENGINE_SRC,
        AL_SLOWFAKE_PAGES: "20",
        AL_SLOWFAKE_PAGE_DELAY_MS: "250",
        AL_SLOWFAKE_INTER_PAGE_DELAY_MS: "100",
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    // 显式设定足够宽的视口（表格 min-width 996px + 工具栏），避免 CI runner
    // 窗口内容区偏窄导致表格列被压缩、表头复选框被工具栏/行遮挡。
    await page.setViewportSize({ width: 1280, height: 760 });
    await waitForSidecar(page);

    const created = await page.evaluate(async (dir) => {
      const api = (window as any).archiveLens;
      const demo = await api.demo.create();
      const draft = await api.tasks.create({ source_dir: dir, search_text: "档案" });
      return {
        demoId: demo.task_id as string,
        demoWorkspace: demo.workspace_dir as string,
        draftId: draft.task_id as string,
      };
    }, sourceDir);

    await openTaskCenter(page);
    const selectPage = page.getByRole("checkbox", { name: "选择当前页" });
    await selectPage.check();
    await expect(page.getByLabel("批量任务操作")).toContainText("已选择 2 个任务");
    await expect(page.getByLabel("批量操作预检")).toContainText("可取消 1，跳过 1");

    await page.getByRole("textbox", { name: "搜索任务" }).fill("不存在的任务");
    await page.getByRole("button", { name: /搜索/ }).click();
    await expect(page.getByLabel("批量任务操作")).toHaveCount(0);
    await page.getByRole("textbox", { name: "搜索任务" }).fill("");
    await page.getByRole("button", { name: /搜索/ }).click();
    await expect(page.getByRole("table", { name: "全部任务" })).toBeVisible();

    await selectPage.check();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "批量取消" }).click();
    const cancelReport = page.locator(".al-task-batch-report");
    await expect(cancelReport).toContainText("批量取消结果");
    await expect(cancelReport).toContainText("成功 1，跳过 1，失败 0");
    await expect.poll(() => page.evaluate(async (taskId) => (
      await (window as any).archiveLens.tasks.get(taskId)
    ).status, created.draftId)).toBe("cancelled");

    const outsideDir = path.join(runRoot, "outside-secret");
    await mkdir(outsideDir, { recursive: true });
    const secretFile = path.join(outsideDir, "secret.txt");
    await writeFile(secretFile, "must-not-be-deleted", "utf8");
    const junctionChild = path.join(created.demoWorkspace, "batch-escape-link");
    await execFileAsync("cmd", ["/c", "mklink", "/J", junctionChild, outsideDir], { windowsHide: true });

    await selectPage.check();
    await expect(page.getByLabel("批量操作预检")).toContainText("可删除或重试清理 2，跳过 0");
    await page.getByRole("button", { name: "批量删除" }).click();
    const deleteDialog = page.getByRole("dialog", { name: "确认批量删除或重试清理？" });
    await expect(deleteDialog).toContainText("2 个可执行、0 个将跳过");
    await expect(deleteDialog).toContainText("不会删除任何原始 PDF、DjVu、TIFF、JPEG 或 PNG 文件");
    await expect(deleteDialog.getByRole("spinbutton")).toHaveCount(0);
    await deleteDialog.getByRole("button", { name: "按清单执行" }).click();

    const deleteReport = page.locator(".al-task-batch-report");
    await expect(deleteReport).toContainText("批量删除结果");
    await expect(deleteReport).toContainText("成功 1，跳过 0，失败 1");
    await expect(deleteReport.getByRole("button", { name: "重试失败项（1）" })).toBeVisible();
    await expect(page.getByText("清理失败").first()).toBeVisible();
    expect(await access(sourceFile).then(() => true, () => false)).toBe(true);
    expect(await access(secretFile).then(() => true, () => false)).toBe(true);

    await rmdir(junctionChild);
    await deleteReport.getByRole("button", { name: "重试失败项（1）" }).click();
    await expect(page.locator(".al-task-batch-report")).toContainText("成功 1，跳过 0，失败 0");
    await expect.poll(() => page.evaluate(async () => (
      await (window as any).archiveLens.tasks.list({ limit: 20, offset: 0 })
    ).total)).toBe(0);
    expect(await access(sourceFile).then(() => true, () => false)).toBe(true);
    expect(await access(secretFile).then(() => true, () => false)).toBe(true);

    const runningId = await page.evaluate(async (dir) => {
      const api = (window as any).archiveLens;
      const task = await api.tasks.create({ source_dir: dir, search_text: "档案" });
      await api.tasks.start(task.task_id);
      return task.task_id as string;
    }, sourceDir);
    await openTaskCenter(page);
    await expect(page.getByRole("checkbox", { name: /选择任务/ })).toHaveCount(1);
    await page.getByRole("checkbox", { name: /选择任务/ }).check();
    await expect(page.getByLabel("批量操作预检")).toContainText("可暂停 1，跳过 0");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "批量暂停" }).click();
    await expect(page.locator(".al-task-batch-report")).toContainText("批量暂停结果");
    await expect(page.locator(".al-task-batch-report")).toContainText("成功 1，跳过 0，失败 0");
    await expect.poll(() => page.evaluate(async (taskId) => (
      await (window as any).archiveLens.tasks.get(taskId)
    ).status, runningId)).toMatch(/pausing|paused/);

    await page.evaluate(async (taskId) => {
      await (window as any).archiveLens.tasks.cancel(taskId);
    }, runningId);
    await expect.poll(() => page.evaluate(async (taskId) => (
      await (window as any).archiveLens.tasks.get(taskId)
    ).status, runningId)).toBe("cancelled");
  } finally {
    await app?.close().catch(() => undefined);
    await rm(runRoot, { recursive: true, force: true });
  }
});

test("1080px 窄窗口下任务中心核心交互无指针拦截", async () => {
  // 不固定到 1280：在 1080×760（贴近低分辨率笔记本）下验证表格、复选框、
  // 批量栏和行操作按钮无 pointer interception。表格 min-width 996px 在 1080 下
  // 仍可完整显示，但工具栏会水平滚动——此测试确保滚动/层叠不遮挡可点击元素。
  const runRoot = await mkdtemp(path.join(os.tmpdir(), "archivelens-task-1080-"));
  const userDataDir = path.join(runRoot, "user-data");
  const sourceDir = path.join(runRoot, "source");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(sourceDir, { recursive: true });
  await writeFile(path.join(runRoot, ".archivelens-test-owned"), "task-1080\n", "utf-8");
  await copyFile(SOURCE_FIXTURE, path.join(sourceDir, "a.png"));

  let app: ElectronApplication | null = null;
  try {
    const python = await resolvePythonExecutable();
    app = await electron.launch({
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
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.setViewportSize({ width: 1080, height: 760 });
    await waitForSidecar(page);

    // 建立两个任务，确保表格有数据行可交互。
    const ids = await page.evaluate(async (dir) => {
      const api = (window as any).archiveLens;
      const a = await api.tasks.create({ source_dir: dir, search_text: "档案" });
      const b = await api.tasks.create({ source_dir: dir, search_text: "文献" });
      return [a.task_id, b.task_id] as string[];
    }, sourceDir);

    await openTaskCenter(page);
    await expect(page.getByRole("table", { name: "全部任务" })).toBeVisible();

    // 1080×760（< 1180px 断点）下任务中心表格进入卡片式布局：表头视觉隐藏
    // （sr-only），每行作为卡片，单行复选框可见可点。这是既有的产品响应式设计。
    // 此测试验证卡片模式下真实用户交互无指针拦截。

    // 单行复选框（可见方框 indicator 在视口内）可点击，选中后批量栏同步出现。
    // 点击 Fluent Checkbox 的可见 wrapper（.fui-Checkbox），它承载 indicator 方框。
    const firstRowCheckbox = page.locator(".al-task-table-row").first().locator(".fui-Checkbox");
    await firstRowCheckbox.click();
    await expect(page.getByLabel("批量任务操作")).toContainText("已选择 1 个任务");

    // 第二行复选框可点击，选中数量同步为 2。
    const secondRowCheckbox = page.locator(".al-task-table-row").nth(1).locator(".fui-Checkbox");
    await secondRowCheckbox.click();
    await expect(page.getByLabel("批量任务操作")).toContainText("已选择 2 个任务");
    await expect(page.getByLabel("批量操作预检")).toBeVisible();

    // 行操作按钮可点击（卡片模式的操作区）。
    const firstRowAction = page.locator(".al-task-table-row").first().getByRole("button").first();
    await expect(firstRowAction).toBeEnabled();

    // 取消第一行选择，批量栏同步更新为 1。
    await firstRowCheckbox.click();
    await expect(page.getByLabel("批量任务操作")).toContainText("已选择 1 个任务");

    // 清理创建的任务（draft/活跃任务需先取消再删除）。
    await page.evaluate(async (taskIds) => {
      const api = (window as any).archiveLens;
      for (const id of taskIds) {
        try { await api.tasks.cancel(id); } catch { /* 已终态则忽略 */ }
        try {
          for (let i = 0; i < 20; i++) {
            const t = await api.tasks.get(id);
            if (["cancelled", "completed", "failed"].includes(t.status)) break;
            await new Promise((r) => setTimeout(r, 200));
          }
        } catch { /* ignore */ }
        try { await api.tasks.delete(id); } catch { /* ignore */ }
      }
    }, ids);
  } finally {
    await app?.close().catch(() => undefined);
    await rm(runRoot, { recursive: true, force: true });
  }
});
