import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";


const APP_DIR = path.resolve(__dirname, "..");
const ROOT_DIR = path.resolve(APP_DIR, "..", "..");
const ENGINE_SRC = path.join(ROOT_DIR, "engine", "src");
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


test("offline HTML report navigates permanent sequences across pages", async () => {
  const runRoot = await mkdtemp(path.join(os.tmpdir(), "archivelens-html-navigation-"));
  const reportPath = path.join(runRoot, "offline-review.html");
  const generatorPath = path.join(runRoot, "generate-report.py");
  const electronMainPath = path.join(runRoot, "electron-main.cjs");
  const generator = String.raw`
from pathlib import Path
import sys
from PIL import Image
from archivelens_engine.html_export import write_offline_review_report

root = Path(sys.argv[1])
output = Path(sys.argv[2])
(root / "pages").mkdir(parents=True, exist_ok=True)
Image.new("RGB", (1200, 1600), "white").save(root / "pages" / "page-1.png")
items = []
for sequence in range(25, 0, -1):
    items.append({
        "occurrence_id": f"occurrence-{sequence}",
        "global_sequence": sequence,
        "document_id": "document-1",
        "source_id": "source-1",
        "source_ordinal": 0,
        "file_name": "合成档案.pdf",
        "relative_path": "第一卷/合成档案.pdf",
        "page_number": 1,
        "matched_text": "亏空",
        "context_full": f"这是第 {sequence:02d} 条完整上下文，包含亏空二字。",
        "ocr_confidence": 0.9,
        "review_decision": "confirmed" if sequence % 2 else None,
        "review_note": f"合成备注 {sequence:02d}",
        "page_image_relpath": "pages/page-1.png",
        "normalized_x0": 0.1,
        "normalized_y0": 0.1 + sequence / 1000,
        "normalized_x1": 0.2,
        "normalized_y1": 0.16 + sequence / 1000,
    })
write_offline_review_report(
    output_path=output,
    task={"name": "离线导航合成验收", "search_text": "亏空"},
    items=items,
    integrity={
        "confirmed_count": 13,
        "needs_review_count": 0,
        "rejected_count": 0,
        "unreviewed_count": 12,
        "scan_complete": True,
        "review_complete": False,
        "fully_verified": False,
    },
    workspace_dir=root,
    exported_at="2026-07-18T12:00:00+08:00",
    expected_page_count=1,
)
`;

  let app: ElectronApplication | null = null;
  let page: Page | null = null;

  try {
    const python = await resolvePythonExecutable();
    await writeFile(generatorPath, generator, "utf8");
    await execFileAsync(python, [generatorPath, runRoot, reportPath], {
      env: { ...process.env, PYTHONPATH: ENGINE_SRC },
    });
    const rawReport = await readFile(reportPath, "utf8");
    expect(rawReport.match(/data:image\/png;base64,/g)).toHaveLength(1);
    expect(rawReport).not.toContain(runRoot);

    await writeFile(electronMainPath, `
const { app, BrowserWindow } = require("electron");
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1440,
    height: 1000,
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  await window.loadURL("data:text/html,<title>ArchiveLens offline report smoke</title>");
});
app.on("window-all-closed", () => app.quit());
`, "utf8");
    app = await electron.launch({ args: [electronMainPath], cwd: runRoot });
    page = await app.firstWindow();
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const externalRequests: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("request", (request) => {
      if (/^https?:/i.test(request.url())) externalRequests.push(request.url());
    });
    await page.goto(pathToFileURL(reportPath).href, { waitUntil: "load" });
    await expect(page.locator(".record-nav-item")).toHaveCount(25);
    await expect(page.locator("#record-nav-count")).toHaveText("25");
    await expect(page.locator("#record-nav-reveal-count")).toHaveText("25");
    await expect(page.locator("#record-nav-mobile-count")).toHaveText("25");
    await expect(page.locator("#record-nav-reveal")).toBeHidden();
    await expect(page.locator(".record-nav-item").first()).toHaveClass(/is-current/);
    await expect(page.locator(".record-nav-item").first()).toHaveAttribute("aria-current", "location");
    await expect(page.locator(".occurrence-card")).toHaveCount(20);
    await expect(page.locator(".source-sequence").first()).toContainText("#0001 · 合成档案.pdf · 第 1 页");
    const firstPageImage = page.locator(".occurrence-card").first().locator(".image-stage img");
    await expect(firstPageImage).toHaveAttribute("src", /^data:image\/png;base64,/);
    await expect.poll(() => firstPageImage.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await expect(page.locator("#sort-order")).toHaveValue("sequence");
    await expect(page.locator("#page-indicator")).toHaveText("第 1 / 2 页");

    const cardOrder = await page.locator(".occurrence-card").first().evaluate((card) =>
      [...card.children].map((child) => child.className),
    );
    expect(cardOrder).toEqual(["card-head", "record-text", "image-button"]);
    await expect(page.locator(".occurrence-card").first().locator(".hit-overlay-svg rect")).toHaveCount(1);

    const normalTransition = await page.locator("#review-layout").evaluate((element) =>
      getComputedStyle(element).transitionDuration,
    );
    expect(normalTransition).toContain("0.18s");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(page.locator("#review-layout")).toHaveCSS("transition-duration", "0s");

    await page.locator(".occurrence-card").nth(1).evaluate((card) => card.scrollIntoView({ block: "start" }));
    await expect(page.locator(".record-nav-item").nth(1)).toHaveAttribute("aria-current", "location");
    expect(await page.locator("#record-nav-list").evaluate((element) => element.scrollTop)).toBe(0);

    await page.locator(".record-nav-item").nth(24).click();
    await expect(page.locator("#page-indicator")).toHaveText("第 2 / 2 页");
    await expect(page.locator(".source-sequence")).toHaveText(["#0021 · 合成档案.pdf · 第 1 页", "#0022 · 合成档案.pdf · 第 1 页", "#0023 · 合成档案.pdf · 第 1 页", "#0024 · 合成档案.pdf · 第 1 页", "#0025 · 合成档案.pdf · 第 1 页"]);
    await expect(page.locator(".occurrence-card").last()).toHaveClass(/targeted/);
    await expect(page.locator(".record-nav-item").last()).toHaveAttribute("aria-current", "location");
    expect(await page.locator("#record-nav-list").evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

    await page.locator("#report-search").fill("完整上下文，包含亏空");
    await expect(page.locator(".record-nav-item")).toHaveCount(25);
    await page.locator("#report-search").fill("第 07 条");
    await expect(page.locator(".record-nav-item")).toHaveCount(1);
    await expect(page.locator(".source-sequence")).toContainText("#0007");
    await expect(page.locator("#record-nav-count")).toHaveText("1");
    await expect(page.locator(".record-nav-item")).toHaveAttribute("aria-current", "location");
    await page.locator("#report-search").fill("不存在的命中内容");
    await expect(page.locator(".record-nav-item")).toHaveCount(0);
    await expect(page.locator("#record-nav-count")).toBeHidden();
    await expect(page.locator("#record-nav-reveal-count")).toBeHidden();
    await page.locator("#reset-filters").click();

    await page.locator(".image-button").first().click();
    await expect(page.locator("#modal-title")).toContainText("#0001");
    await expect(page.locator("#modal-image .hit-overlay-svg rect")).toHaveCount(1);
    await page.locator("#modal-next").click();
    await expect(page.locator("#modal-title")).toContainText("#0002");
    await page.locator("#modal-close").click();

    const expandedColumns = await page.locator("#review-layout").evaluate((element) =>
      getComputedStyle(element).gridTemplateColumns,
    );
    expect(expandedColumns.startsWith("320px ")).toBe(true);
    const expandedPaneWidth = await page.locator(".result-pane").evaluate((element) =>
      element.getBoundingClientRect().width,
    );
    await page.locator("#record-nav-toggle").click();
    await expect(page.locator("#record-nav-toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#record-nav-reveal")).toBeVisible();
    await expect(page.locator("#record-nav-reveal")).toHaveAttribute("aria-expanded", "false");
    const collapsedColumns = await page.locator("#review-layout").evaluate((element) =>
      getComputedStyle(element).gridTemplateColumns,
    );
    expect(collapsedColumns.startsWith("0px ")).toBe(true);
    const collapsedPaneWidth = await page.locator(".result-pane").evaluate((element) =>
      element.getBoundingClientRect().width,
    );
    expect(collapsedPaneWidth).toBeGreaterThan(expandedPaneWidth + 250);
    const revealAndText = await page.evaluate(() => {
      const reveal = document.querySelector<HTMLElement>("#record-nav-reveal")!.getBoundingClientRect();
      const text = document.querySelector<HTMLElement>(".source-sequence")!.getBoundingClientRect();
      return { revealRight: reveal.right, textLeft: text.left };
    });
    expect(revealAndText.revealRight).toBeLessThanOrEqual(revealAndText.textLeft);

    await page.locator("#record-nav-reveal").press("Enter");
    await expect(page.locator("#record-nav-reveal")).toBeHidden();
    await page.setViewportSize({ width: 800, height: 900 });
    await expect(page.locator("#record-nav")).toHaveCSS("position", "static");
    await expect(page.locator("#record-nav-mobile-toggle")).toBeVisible();
    await expect(page.locator("#record-nav-toggle")).toBeHidden();
    await expect(page.locator("#record-nav-reveal")).toBeHidden();
    const mobileColumns = await page.locator("#review-layout").evaluate((element) =>
      getComputedStyle(element).gridTemplateColumns.split(" ").length,
    );
    expect(mobileColumns).toBe(1);
    await page.locator("#record-nav-mobile-toggle").click();
    await expect(page.locator("#record-nav-mobile-toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#record-nav-list")).toBeHidden();
    await page.locator("#record-nav-mobile-toggle").press("Enter");
    await expect(page.locator("#record-nav-list")).toBeVisible();

    await page.emulateMedia({ media: "print", reducedMotion: "reduce" });
    await expect(page.locator("#record-nav")).toBeHidden();
    await expect(page.locator("#record-nav-mobile-toggle")).toBeHidden();
    await page.emulateMedia({ media: "screen", reducedMotion: "reduce" });

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator("#record-nav-toggle").click();
    await expect(page.locator("#record-nav-reveal")).toBeVisible();
    await page.reload({ waitUntil: "load" });
    await expect(page.locator("#review-layout")).not.toHaveClass(/nav-collapsed/);
    await expect(page.locator("#record-nav-reveal")).toBeHidden();

    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(externalRequests).toEqual([]);
  } finally {
    await app?.close();
    await rm(runRoot, { recursive: true, force: true });
  }
});
