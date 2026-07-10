import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { access, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";


const APP_DIR = path.resolve(__dirname, "..");
const ROOT_DIR = path.resolve(APP_DIR, "..", "..");
const ENGINE_SRC = path.join(ROOT_DIR, "engine", "src");
const FIXTURE = path.join(ROOT_DIR, "tests", "fixtures", "ocr", "custom-double.pdf");
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
    try {
      const { readdir } = await import("node:fs/promises");
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
  await expect.poll(async () => page.evaluate(async () => {
    const environment = await (window as any).archiveLens.app.getEnvironment();
    return environment.sidecarReady;
  })).toBe(true);
}


test("custom search UI creates a real OCR task and renders complete word evidence", async () => {
  const resultRoot = path.join(APP_DIR, "test-results");
  await mkdir(resultRoot, { recursive: true });
  await writeFile(path.join(resultRoot, ".archivelens-runid"), `${RUN_ID}\n`, "utf8");
  const runRoot = await mkdtemp(path.join(os.tmpdir(), `archivelens-ocr-temp-${RUN_ID}-custom-ui-`));
  await writeFile(path.join(runRoot, ".archivelens-test-owned"), `${RUN_ID}\n`, "utf8");
  const sourceDir = path.join(runRoot, "source");
  const userDataDir = path.join(runRoot, "user-data");
  await mkdir(sourceDir, { recursive: true });
  await copyFile(FIXTURE, path.join(sourceDir, path.basename(FIXTURE)));

  let app: ElectronApplication | null = null;
  let reportPage: Page | null = null;
  try {
    const python = await resolvePythonExecutable();
    app = await electron.launch({
      args: [APP_DIR],
      cwd: APP_DIR,
      env: {
        ...process.env,
        ARCHIVELENS_E2E: "1",
        ARCHIVELENS_E2E_SELECT_FOLDER: sourceDir,
        ARCHIVELENS_USER_DATA_DIR: userDataDir,
        AL_DEBUG: "1",
        AL_ENGINE_DEV: python,
        AL_ENGINE_SRC: ENGINE_SRC,
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await waitForSidecar(page);

    await page.getByRole("link", { name: "新建扫描" }).click();
    const searchInput = page.getByRole("textbox", { name: "检索文字或词语" });
    const startButton = page.getByRole("button", { name: "开始扫描" });
    await expect(startButton).toBeDisabled();

    await searchInput.fill("档".repeat(33));
    await expect(startButton).toBeDisabled();
    await expect(page.getByRole("alert")).toContainText("检索词最多 32 个字符");
    await searchInput.fill("\uFEFF档案");
    await expect(startButton).toBeDisabled();
    await expect(page.getByRole("alert")).toContainText("检索词不能包含特殊不可见字符");
    await searchInput.fill("e\u0301");
    await expect(startButton).toBeDisabled();

    await page.getByRole("button", { name: "选择文件夹" }).click();
    await expect(page.getByPlaceholder("点击右侧按钮选择文件夹")).toHaveValue(sourceDir);
    await expect(startButton).toBeEnabled();

    await searchInput.fill("档".repeat(32));
    await expect(startButton).toBeEnabled();
    await searchInput.fill("档案");
    await startButton.click();
    await expect(page).toHaveURL(/#\/tasks\/task_/);
    await expect(page.getByText("检索词：档案")).toBeVisible();
    await expect(page.getByText("匹配模式：精确匹配")).toBeVisible();

    const taskId = page.url().split("/tasks/")[1]!;
    await expect.poll(async () => page.evaluate(async (id) => {
      return (await (window as any).archiveLens.tasks.get(id)).status;
    }, taskId), { timeout: 60_000 }).toBe("completed");

    await page.getByRole("button", { name: "进入校对工作台" }).click();
    await expect(page.getByText("档案", { exact: true }).first()).toBeVisible();
    await expect(page.locator('img[alt="出处页"]')).toBeVisible();
    await expect(page.locator('img[alt="检索词截取"]')).toBeVisible();
    const highlight = await page.locator(".al-highlight").boundingBox();
    expect(highlight).not.toBeNull();
    expect(highlight!.width).toBeGreaterThan(20);
    expect(highlight!.height).toBeGreaterThan(10);
    const dimensions = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      bodyWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);

    const occurrenceId = await page.evaluate(async (id) => {
      const result = await (window as any).archiveLens.results.query({ task_id: id, limit: 10 });
      return result.items[0].occurrence_id as string;
    }, taskId);
    await page.evaluate(async ({ id, occurrence }) => {
      await (window as any).archiveLens.review.updateDecision({
        task_id: id,
        occurrence_id: occurrence,
        decision: "confirmed",
      });
      await (window as any).archiveLens.review.updateNote({
        task_id: id,
        occurrence_id: occurrence,
        note: "A&B <script>alert(1)</script> <img src=x onerror=alert(1)>",
      });
    }, { id: taskId, occurrence: occurrenceId });

    const htmlPath = await page.evaluate(async (id) => {
      return (await (window as any).archiveLens.export.html(id)).path as string;
    }, taskId);
    const reportWindow = app.waitForEvent("window");
    await app.evaluate(async ({ BrowserWindow }) => {
      const report = new BrowserWindow({
        show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      (globalThis as any).__archiveLensExportSmokeWindow = report;
      await report.loadURL("data:text/html,<title>ArchiveLens export smoke</title>");
    });
    reportPage = await reportWindow;
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const externalRequests: string[] = [];
    reportPage.on("pageerror", (error) => pageErrors.push(error.message));
    reportPage.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    reportPage.on("request", (request) => {
      if (/^https?:/i.test(request.url())) externalRequests.push(request.url());
    });
    await reportPage.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
    const offlineReport = await reportPage.evaluate(() => ({
      text: document.body.textContent ?? "",
      scriptCount: document.querySelectorAll("script").length,
      eventHandlerCount: [...document.querySelectorAll("*")].reduce(
        (count, element) => count + [...element.attributes].filter((attribute) => /^on/i.test(attribute.name)).length,
        0,
      ),
      externalReferences: [...document.querySelectorAll("[src], [href]")]
        .flatMap((element) => [element.getAttribute("src"), element.getAttribute("href")])
        .filter((value): value is string => Boolean(value && /^https?:/i.test(value))),
      imagesLoaded: [...document.images].every((image) => image.complete && image.naturalWidth > 0),
    }));
    expect(offlineReport.text).toContain("检索词：档案");
    expect(offlineReport.text).toContain("A&B <script>alert(1)</script> <img src=x onerror=alert(1)>");
    expect(offlineReport.scriptCount).toBe(0);
    expect(offlineReport.eventHandlerCount).toBe(0);
    expect(offlineReport.externalReferences).toEqual([]);
    expect(offlineReport.imagesLoaded).toBe(true);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(externalRequests).toEqual([]);
    await reportPage.close();
    reportPage = null;
  } finally {
    if (reportPage) await reportPage.close().catch(() => undefined);
    if (app) await app.close().catch(() => undefined);
    await rm(runRoot, { recursive: true, force: true });
  }
});
