import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";


const APP_DIR = path.resolve(__dirname, "..");
const ROOT_DIR = path.resolve(APP_DIR, "..", "..");
const ENGINE_SRC = path.join(ROOT_DIR, "engine", "src");
const FIXTURE = path.join(ROOT_DIR, "tests", "fixtures", "ocr", "custom-double.pdf");
const RUN_ID = (process.env["ARCHIVELENS_TEST_RUN_ID"] ?? "a11-local").replace(/[^A-Za-z0-9._-]/g, "-");
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


async function comparableExistingPath(value: string): Promise<string> {
  const canonical = path.normalize(await realpath(value));
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

async function makeOwnedRunRoot(label: string): Promise<string> {
  const runRoot = await mkdtemp(path.join(os.tmpdir(), `archivelens-ocr-temp-${RUN_ID}-${label}-`));
  await writeFile(path.join(runRoot, ".archivelens-test-owned"), `${RUN_ID}\n`, "utf8");
  return runRoot;
}


test("custom search UI creates a real OCR task and renders complete word evidence", async () => {
  const resultRoot = path.join(APP_DIR, "test-results");
  await mkdir(resultRoot, { recursive: true });
  await writeFile(path.join(resultRoot, ".archivelens-runid"), `${RUN_ID}\n`, "utf8");
  const runRoot = await makeOwnedRunRoot("custom-ui");
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
    await expect(page.getByLabel("文件夹预检结果")).toContainText("支持的档案");
    await expect(page.getByLabel("文件夹预检结果")).toContainText("可用磁盘");
    await expect(page.getByText("预检通过，可以创建扫描任务。")).toBeVisible();
    await expect(startButton).toBeEnabled();

    await searchInput.fill("档".repeat(32));
    await expect(startButton).toBeEnabled();
    await searchInput.fill("档案");
    await startButton.click();
    await expect(page).toHaveURL(/#\/tasks\/task_/);
    const taskFacts = page.locator(".al-task-keyfacts");
    await expect(taskFacts).toContainText("检索词档案");
    await expect(taskFacts).toContainText("匹配模式精确匹配");

    const taskId = page.url().split("/tasks/")[1]!;
    await expect.poll(async () => page.evaluate(async (id) => {
      return (await (window as any).archiveLens.tasks.get(id)).status;
    }, taskId), { timeout: 60_000 }).toBe("completed");
    const scanEvidence = await page.evaluate(async (id) => {
      const task = await (window as any).archiveLens.tasks.get(id);
      const results = await (window as any).archiveLens.results.query({ task_id: id, limit: 1 });
      return { preferences: task.review_preferences, occurrence: results.items[0] };
    }, taskId);
    expect(scanEvidence.preferences).toEqual({
      page_quality: "maximum",
      context_direction: "ltr",
      context_radius: 15,
    });
    expect(scanEvidence.occurrence.page_image_width).toBe(scanEvidence.occurrence.source_page_width);

    await page.getByRole("button", { name: "任务内检索" }).click();
    await expect(page).toHaveURL(new RegExp(`#\\/search\\/${taskId}$`));
    const taskSearchInput = page.getByRole("textbox", { name: "任务内检索文字或词语" });
    await expect(taskSearchInput).toHaveValue("档案");
    await page.getByRole("button", { name: "检索", exact: true }).click();
    await expect(page.locator(".al-search-result").first()).toBeVisible();
    await expect(page.locator(".al-search-raw-evidence")).toContainText("档案");
    await expect(page.locator('img[alt="检索结果出处页"]')).toBeVisible();
    await expect(page.locator(".al-search-highlight")).toBeVisible();

    await page.getByLabel("命中字形范围").selectOption("traditional");
    await taskSearchInput.fill("档案");
    await page.getByRole("button", { name: "检索", exact: true }).click();
    await expect(page.getByText("没有符合当前字形范围的结果")).toBeVisible();

    await page.getByLabel("命中字形范围").selectOption("both");
    await taskSearchInput.fill("檔案");
    await page.getByRole("button", { name: "检索", exact: true }).click();
    await expect(page.locator(".al-search-result").first()).toBeVisible();
    await expect(page.getByText("简繁字形索引命中").first()).toBeVisible();
    await expect(page.locator(".al-search-history-scroll button")).toHaveCount(3);
    await page.getByRole("link", { name: "任务详情" }).click();

    await page.getByRole("button", { name: "进入校对工作台" }).click();
    await expect(page.getByText("档案", { exact: true }).first()).toBeVisible();
    await expect(page.locator('img[alt="出处页"]')).toBeVisible();
    const resultThumbnail = page.locator(".al-result-thumbnail").first();
    await expect(resultThumbnail.locator("img")).toBeVisible();
    await expect(resultThumbnail.locator(".al-result-thumbnail-highlight")).toBeVisible();
    await expect(page.locator('img[alt="检索词截取"]')).toHaveCount(0);
    const highlight = await page.locator(".al-highlight").boundingBox();
    expect(highlight).not.toBeNull();
    expect(highlight!.width).toBeGreaterThan(20);
    expect(highlight!.height).toBeGreaterThan(10);
    await expect(page.locator(".al-highlight")).toHaveCSS("border-top-width", "0px");
    await expect(page.locator(".al-highlight")).toHaveCSS("background-color", "rgba(196, 69, 22, 0.18)");
    const pageImage = page.locator('img[alt="出处页"]');
    const pageWrap = page.locator(".al-page-wrap");
    const visualOutput = path.join(ROOT_DIR, "output", "playwright");
    await mkdir(visualOutput, { recursive: true });
    const hasEnoughPhysicalPixels = () => pageImage.evaluate((image) => {
      const rect = image.getBoundingClientRect();
      const orientation = image.closest(".al-page-canvas")?.getAttribute("data-orientation");
      const swapsAxes = orientation === "right" || orientation === "left";
      const requiredSourceWidth = (swapsAxes ? rect.height : rect.width) * window.devicePixelRatio;
      const requiredSourceHeight = (swapsAxes ? rect.width : rect.height) * window.devicePixelRatio;
      return image.naturalWidth + 1 >= Math.ceil(requiredSourceWidth)
        && image.naturalHeight + 1 >= Math.ceil(requiredSourceHeight);
    });
    const waitForEvidenceSettled = async () => {
      await expect(page.locator(".al-page-fidelity-status")).toHaveCount(0);
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }));
    };
    await expect(page.locator(".al-zoom-value")).toHaveText("100%");
    await expect(page.getByRole("button", { name: "页面朝上（0°）" })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(hasEnoughPhysicalPixels).toBe(true);
    await waitForEvidenceSettled();
    await page.screenshot({ path: path.join(visualOutput, "review-pdf-100-source-fidelity.png") });
    await page.getByRole("button", { name: "适应窗口" }).click();
    await expect.poll(async () => Number((await page.locator(".al-zoom-value").textContent())?.replace("%", ""))).toBeLessThan(100);
    await expect.poll(hasEnoughPhysicalPixels).toBe(true);
    await waitForEvidenceSettled();
    await page.screenshot({ path: path.join(visualOutput, "review-pdf-fit-source-fidelity.png") });
    await page.getByRole("button", { name: "100%" }).click();
    await expect(page.locator(".al-zoom-value")).toHaveText("100%");
    const imageBeforeDrag = await pageImage.boundingBox();
    const highlightBeforeDrag = await page.locator(".al-highlight").boundingBox();
    const wrapBox = await pageWrap.boundingBox();
    expect(imageBeforeDrag).not.toBeNull();
    expect(highlightBeforeDrag).not.toBeNull();
    expect(wrapBox).not.toBeNull();
    await page.mouse.move(wrapBox!.x + wrapBox!.width / 2, wrapBox!.y + wrapBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(wrapBox!.x + wrapBox!.width / 2 + 48, wrapBox!.y + wrapBox!.height / 2 - 32);
    await page.mouse.up();
    const imageAfterDrag = await pageImage.boundingBox();
    const highlightAfterDrag = await page.locator(".al-highlight").boundingBox();
    expect(imageAfterDrag).not.toBeNull();
    expect(highlightAfterDrag).not.toBeNull();
    expect(Math.abs((highlightAfterDrag!.x - imageAfterDrag!.x) - (highlightBeforeDrag!.x - imageBeforeDrag!.x))).toBeLessThan(1);
    expect(Math.abs((highlightAfterDrag!.y - imageAfterDrag!.y) - (highlightBeforeDrag!.y - imageBeforeDrag!.y))).toBeLessThan(1);
    await page.getByRole("button", { name: "放大页面" }).click();
    await expect(page.locator(".al-zoom-value")).toHaveText("125%");
    const imageBeforeRotation = await pageImage.boundingBox();
    await page.getByRole("button", { name: "页面朝右（90°）" }).click();
    await expect(page.getByRole("button", { name: "页面朝右（90°）" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".al-page-canvas")).toHaveAttribute("data-orientation", "right");
    await expect(page.locator(".al-zoom-value")).toHaveText("125%");
    await expect.poll(hasEnoughPhysicalPixels).toBe(true);
    await waitForEvidenceSettled();
    const imageAfterRotation = await pageImage.boundingBox();
    const highlightAfterRotation = await page.locator(".al-highlight").boundingBox();
    const positionerAfterRotation = await page.locator(".al-page-positioner").boundingBox();
    expect(imageBeforeRotation).not.toBeNull();
    expect(imageAfterRotation).not.toBeNull();
    expect(highlightAfterRotation).not.toBeNull();
    expect(positionerAfterRotation).not.toBeNull();
    expect(Math.abs(imageAfterRotation!.width - imageBeforeRotation!.height)).toBeLessThan(2);
    expect(Math.abs(imageAfterRotation!.height - imageBeforeRotation!.width)).toBeLessThan(2);
    expect(Math.abs(positionerAfterRotation!.x + positionerAfterRotation!.width / 2 - (wrapBox!.x + wrapBox!.width / 2))).toBeLessThan(2);
    expect(Math.abs(positionerAfterRotation!.y + positionerAfterRotation!.height / 2 - (wrapBox!.y + wrapBox!.height / 2))).toBeLessThan(2);
    expect(highlightAfterRotation!.x).toBeGreaterThanOrEqual(imageAfterRotation!.x - 1);
    expect(highlightAfterRotation!.y).toBeGreaterThanOrEqual(imageAfterRotation!.y - 1);
    expect(highlightAfterRotation!.x + highlightAfterRotation!.width).toBeLessThanOrEqual(imageAfterRotation!.x + imageAfterRotation!.width + 1);
    expect(highlightAfterRotation!.y + highlightAfterRotation!.height).toBeLessThanOrEqual(imageAfterRotation!.y + imageAfterRotation!.height + 1);
    await expect(resultThumbnail.locator("img")).toHaveCSS("transform", "none");
    await page.screenshot({ path: path.join(visualOutput, "review-pdf-right-source-fidelity.png") });
    for (const orientation of [
      { label: "页面朝下（180°）", value: "down" },
      { label: "页面朝左（270°）", value: "left" },
      { label: "页面朝上（0°）", value: "up" },
      { label: "页面朝右（90°）", value: "right" },
    ]) {
      await page.getByRole("button", { name: orientation.label }).click();
      await expect(page.getByRole("button", { name: orientation.label })).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator(".al-page-canvas")).toHaveAttribute("data-orientation", orientation.value);
      await expect(page.locator(".al-zoom-value")).toHaveText("125%");
    }
    const dimensions = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      bodyWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
    const workbenchLayout = await page.evaluate(() => {
      const main = document.querySelector<HTMLElement>(".al-main");
      const review = document.querySelector<HTMLElement>(".al-review");
      const resultList = document.querySelector<HTMLElement>(".al-result-list");
      const detail = document.querySelector<HTMLElement>(".al-detail");
      const aside = document.querySelector<HTMLElement>(".al-review-aside");
      return {
        documentHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
        mainOverflowY: main ? getComputedStyle(main).overflowY : "missing",
        reviewHeight: review?.getBoundingClientRect().height ?? 0,
        resultOverflowY: resultList ? getComputedStyle(resultList).overflowY : "missing",
        detailOverflowY: detail ? getComputedStyle(detail).overflowY : "missing",
        asideOverflowY: aside ? getComputedStyle(aside).overflowY : "missing",
        asideWidth: aside?.getBoundingClientRect().width ?? 0,
      };
    });
    expect(workbenchLayout.documentHeight).toBeLessThanOrEqual(workbenchLayout.viewportHeight + 1);
    expect(workbenchLayout.reviewHeight).toBeLessThanOrEqual(workbenchLayout.viewportHeight + 1);
    expect(workbenchLayout.mainOverflowY).toBe("hidden");
    expect(workbenchLayout.resultOverflowY).toBe("hidden");
    expect(workbenchLayout.detailOverflowY).toBe("hidden");
    expect(workbenchLayout.asideOverflowY).toBe("hidden");

    await page.getByRole("button", { name: "收起校对摘要" }).click();
    await expect(page.getByRole("button", { name: "展开校对摘要" })).toBeVisible();
    await expect.poll(() => page.locator(".al-review-aside").evaluate((element) => element.getBoundingClientRect().width)).toBeLessThan(80);
    expect(await page.evaluate(() => localStorage.getItem("archivelens.reviewSummaryCollapsed"))).toBe("true");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1080, 680));
    await expect(page.getByRole("button", { name: "立即保存 (Ctrl+Enter)" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBeLessThanOrEqual(1);
    await expect(page.locator(".al-page-wrap")).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 820));
    await page.getByRole("button", { name: "展开校对摘要" }).click();
    await expect(page.getByRole("button", { name: "收起校对摘要" })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("archivelens.reviewSummaryCollapsed"))).toBe("false");

    await page.getByRole("button", { name: "100%" }).click();
    for (let index = 0; index < 7; index += 1) {
      await page.getByRole("button", { name: "放大页面" }).click();
    }
    await expect(page.locator(".al-zoom-value")).toHaveText("400%");
    await expect.poll(hasEnoughPhysicalPixels, { timeout: 45_000 }).toBe(true);
    await waitForEvidenceSettled();
    const toolbarGeometry = await page.evaluate(() => {
      const wrapElement = document.querySelector<HTMLElement>(".al-page-wrap");
      const wrap = wrapElement?.getBoundingClientRect();
      const toolbarElement = document.querySelector<HTMLElement>(".al-viewer-toolbar");
      const toolbar = toolbarElement?.getBoundingClientRect();
      const orientationToolbar = document.querySelector<HTMLElement>(".al-page-orientation-toolbar")?.getBoundingClientRect();
      return wrap && wrapElement && toolbar && orientationToolbar ? {
        wrapLeft: wrap.left,
        wrapRight: wrap.right,
        toolbarLeft: toolbar.left,
        toolbarRight: toolbar.right,
        orientationToolbarLeft: orientationToolbar.left,
        orientationToolbarRight: orientationToolbar.right,
        scrollLeft: wrapElement.scrollLeft,
        scrollTop: wrapElement.scrollTop,
      } : null;
    });
    expect(toolbarGeometry).not.toBeNull();
    expect(toolbarGeometry!.scrollLeft).toBe(0);
    expect(toolbarGeometry!.scrollTop).toBe(0);
    expect(toolbarGeometry!.toolbarLeft).toBeGreaterThanOrEqual(toolbarGeometry!.wrapLeft);
    expect(toolbarGeometry!.toolbarRight).toBeLessThanOrEqual(toolbarGeometry!.wrapRight);
    expect(toolbarGeometry!.orientationToolbarLeft).toBeGreaterThanOrEqual(toolbarGeometry!.wrapLeft);
    expect(toolbarGeometry!.orientationToolbarRight).toBeLessThanOrEqual(toolbarGeometry!.wrapRight);
    await page.screenshot({ path: path.join(visualOutput, "review-pdf-400-source-fidelity.png") });
    const zoomedViewport = await page.evaluate(() => ({ height: window.innerHeight, documentHeight: document.documentElement.scrollHeight }));
    expect(zoomedViewport.documentHeight).toBeLessThanOrEqual(zoomedViewport.height + 1);
    await page.getByRole("button", { name: "适应窗口" }).click();

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
      imagesUnrotated: [...document.querySelectorAll<HTMLImageElement>(".image-stage img")]
        .every((image) => getComputedStyle(image).transform === "none"),
      pageCards: document.querySelectorAll(".page-card").length,
      navItems: document.querySelectorAll(".record-nav-item").length,
      navigationPresent: Boolean(document.getElementById("record-nav")),
      defaultSort: (document.getElementById("sort-order") as HTMLSelectElement | null)?.value,
      cardOrder: [...document.querySelectorAll<HTMLElement>(".occurrence-card")].every((card) =>
        [...card.children].map((child) => child.className).join("|")
          .startsWith("card-head|record-text|image-button"),
      ),
      sequenceLabels: [...document.querySelectorAll<HTMLElement>(".source-sequence")]
        .map((element) => element.textContent ?? ""),
      overlays: document.querySelectorAll(".hit-overlay-svg rect").length,
      controls: ["file-filter", "status-filter", "report-search", "sort-order", "page-size", "print-report"]
        .every((id) => Boolean(document.getElementById(id))),
    }));
    expect(offlineReport.text).toContain("检索词：档案");
    expect(offlineReport.text).toContain("A&B <script>alert(1)</script> <img src=x onerror=alert(1)>");
    expect(offlineReport.scriptCount).toBe(1);
    expect(offlineReport.eventHandlerCount).toBe(0);
    expect(offlineReport.externalReferences).toEqual([]);
    expect(offlineReport.imagesLoaded).toBe(true);
    expect(offlineReport.imagesUnrotated).toBe(true);
    expect(offlineReport.pageCards).toBeGreaterThan(0);
    expect(offlineReport.navItems).toBeGreaterThanOrEqual(offlineReport.pageCards);
    expect(offlineReport.navigationPresent).toBe(true);
    expect(offlineReport.defaultSort).toBe("sequence");
    expect(offlineReport.cardOrder).toBe(true);
    expect(offlineReport.sequenceLabels.every((label) => /^#\d{4,} · /.test(label))).toBe(true);
    expect(offlineReport.overlays).toBeGreaterThan(0);
    expect(offlineReport.controls).toBe(true);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(externalRequests).toEqual([]);
    await reportPage.close();
    reportPage = null;

    await page.getByRole("link", { name: "任务中心" }).click();
    await expect(page.getByRole("button", { name: "校对" })).toBeEnabled();
    const moreActions = page.getByRole("button", { name: /更多操作$/ });
    await expect(moreActions).toBeEnabled();
    await moreActions.click();
    await expect(page.getByRole("menuitem", { name: "详情" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "导出" })).toBeVisible();
    const deleteMenuItem = page.getByRole("menuitem", { name: "删除任务" });
    await expect(deleteMenuItem).toBeVisible();
    await deleteMenuItem.click();
    const deleteDialog = page.getByRole("dialog");
    await expect(deleteDialog).toContainText("不会删除原始文件");
    await expect(deleteDialog).toContainText("生成的页面图片");
    await deleteDialog.getByRole("button", { name: "取消" }).click();
    await moreActions.click();
    await page.getByRole("menuitem", { name: "删除任务" }).click();
    await deleteDialog.getByRole("button", { name: "删除任务" }).click();
    await expect.poll(async () => page.evaluate(async (id) => {
      try {
        await (window as any).archiveLens.tasks.get(id);
        return false;
      } catch {
        return true;
      }
    }, taskId)).toBe(true);
    await access(path.join(sourceDir, path.basename(FIXTURE)));
  } finally {
    if (reportPage) await reportPage.close().catch(() => undefined);
    if (app) await app.close().catch(() => undefined);
    await rm(runRoot, { recursive: true, force: true });
  }
});

test("multiple file selection creates one cross-directory task", async () => {
  const runRoot = await makeOwnedRunRoot("multi-file-ui");
  const userDataDir = path.join(runRoot, "user-data");
  const firstDir = path.join(runRoot, "first");
  const secondDir = path.join(runRoot, "second");
  const firstFile = path.join(firstDir, "first.pdf");
  const secondFile = path.join(secondDir, "second.pdf");
  await mkdir(firstDir, { recursive: true });
  await mkdir(secondDir, { recursive: true });
  await copyFile(FIXTURE, firstFile);
  await copyFile(FIXTURE, secondFile);

  let app: ElectronApplication | null = null;
  try {
    const python = await resolvePythonExecutable();
    app = await electron.launch({
      args: [APP_DIR],
      cwd: APP_DIR,
      env: {
        ...process.env,
        ARCHIVELENS_E2E: "1",
        ARCHIVELENS_E2E_SELECT_FILES: JSON.stringify([firstFile, secondFile]),
        ARCHIVELENS_USER_DATA_DIR: userDataDir,
        AL_SLOWFAKE_PAGES: "1",
        AL_DEBUG: "1",
        AL_ENGINE_DEV: python,
        AL_ENGINE_SRC: ENGINE_SRC,
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await waitForSidecar(page);
    await page.getByRole("link", { name: "新建扫描" }).click();
    await page.getByRole("radio", { name: /多个文件/ }).click();
    await page.getByRole("button", { name: "添加文件" }).click();
    await expect(page.getByLabel("已选文件清单")).toContainText("first.pdf");
    await expect(page.getByLabel("已选文件清单")).toContainText("second.pdf");
    await page.getByRole("textbox", { name: "检索文字或词语" }).fill("档案");
    await page.getByRole("button", { name: "开始扫描" }).click();
    await expect(page).toHaveURL(/#\/tasks\/task_/);
    const taskId = page.url().split("/tasks/")[1]!;
    const expectedSourceFiles = await Promise.all([firstFile, secondFile].map(comparableExistingPath));
    await expect.poll(async () => {
      const task = await page.evaluate(async (id) => {
        const value = await (window as any).archiveLens.tasks.get(id);
        return { source_kind: value.source_kind, file_count: value.file_count, source_files: value.source_files };
      }, taskId);
      return {
        ...task,
        source_files: await Promise.all((task.source_files as string[]).map(comparableExistingPath)),
      };
    }).toEqual({ source_kind: "files", file_count: 2, source_files: expectedSourceFiles });
    await expect.poll(async () => page.evaluate(async (id) => {
      return (await (window as any).archiveLens.tasks.get(id)).status;
    }, taskId)).toBe("completed");
  } finally {
    if (app) await app.close().catch(() => undefined);
    await rm(runRoot, { recursive: true, force: true });
  }
});

test("mixed PNG and multi-page TIFF sources complete as one raster task", async () => {
  const runRoot = await makeOwnedRunRoot("raster-ui");
  const userDataDir = path.join(runRoot, "user-data");
  const sourceDir = path.join(runRoot, "source");
  const pngFile = path.join(sourceDir, "single.png");
  const tiffFile = path.join(sourceDir, "multi.tiff");
  await mkdir(sourceDir, { recursive: true });

  let app: ElectronApplication | null = null;
  try {
    const python = await resolvePythonExecutable();
    await execFileAsync(python, [
      "-c",
      "from PIL import Image; import pypdfium2 as pdfium; import sys; d=pdfium.PdfDocument(sys.argv[3]); d[0].render(scale=2).to_pil().save(sys.argv[1]); d.close(); a=Image.new('L',(100,70),255); a.save(sys.argv[2],save_all=True,append_images=[Image.new('L',(90,60),255)])",
      pngFile,
      tiffFile,
      FIXTURE,
    ]);
    app = await electron.launch({
      args: [APP_DIR],
      cwd: APP_DIR,
      env: {
        ...process.env,
        ARCHIVELENS_E2E: "1",
        ARCHIVELENS_E2E_SELECT_FILES: JSON.stringify([pngFile, tiffFile]),
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
    await page.getByRole("radio", { name: /多个文件/ }).click();
    await page.getByRole("button", { name: "添加文件" }).click();
    await expect(page.getByLabel("已选文件清单")).toContainText("single.png");
    await expect(page.getByLabel("已选文件清单")).toContainText("multi.tiff");
    await page.getByRole("textbox", { name: "检索文字或词语" }).fill("档案");
    await page.getByRole("button", { name: "开始扫描" }).click();
    await expect(page).toHaveURL(/#\/tasks\/task_/);
    const taskId = page.url().split("/tasks/")[1]!;

    await expect.poll(async () => page.evaluate(async (id) => {
      const task = await (window as any).archiveLens.tasks.get(id);
      return { status: task.status, file_count: task.file_count, total_pages: task.total_pages, occurrence_count: task.occurrence_count };
    }, taskId), { timeout: 60_000 }).toMatchObject({ status: "completed", file_count: 2, total_pages: 3 });
    const rasterTask = await page.evaluate(async (id) => (window as any).archiveLens.tasks.get(id), taskId);
    expect(rasterTask.occurrence_count).toBeGreaterThan(0);
    await page.getByRole("button", { name: "进入校对工作台" }).click();
    await expect(page.locator('img[alt="出处页"]')).toBeVisible();
    await page.getByRole("button", { name: "100%" }).click();
    await page.getByRole("button", { name: "放大页面" }).click();
    await expect(page.getByText("仅放大观察，不会增加源文件细节", { exact: true })).toBeVisible();
  } finally {
    if (app) await app.close().catch(() => undefined);
    await rm(runRoot, { recursive: true, force: true });
  }
});
