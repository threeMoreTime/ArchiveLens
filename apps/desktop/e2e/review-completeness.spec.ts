import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const APP_DIR = path.resolve(__dirname, "..");
const ROOT_DIR = path.resolve(APP_DIR, "..", "..");
const ENGINE_SRC = path.join(ROOT_DIR, "engine", "src");
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
  const script = String.raw`
import json, sys
from pathlib import Path
from archivelens_engine.db.store import TaskStore
root = Path(sys.argv[1]) / "engine"
root.mkdir(parents=True, exist_ok=True)
store = TaskStore(root / "archivelens.db")
task_id = store.create_task(name="review completeness", search_terms=["档案"], search_mode="exact_literal", status="completed")
items = []
for index in range(int(sys.argv[2])):
    items.append({
        "occurrence_id": f"occ-{index:04d}",
        "source_id": "seed.pdf",
        "file_name": f"document-{index // 100:02d}.pdf",
        "relative_path": f"document-{index // 100:02d}.pdf",
        "page_number": index // 4 + 1,
        "page_occurrence_index": index % 4,
        "matched_text": "档案",
        "match_start": 0,
        "match_end": 2,
        "bbox_hash": f"bbox-{index:04d}",
        "context_full": f"档案结果 {index}",
        "verification_status": "needs_review",
    })
store.add_occurrences(task_id, items)
print(json.dumps({"taskId": task_id, "occurrenceIds": [item["occurrence_id"] for item in items]}))
store.close()
`;
  const result = await execFileAsync(python, ["-c", script, userDataDir, String(count)], {
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

test("E2E-01：201 条结果可通过三页完整访问", async () => {
  const userDataDir = await makeOwnedUserData();
  const seeded = await seedReviewTask(userDataDir, 201);
  const app = await launchDesktop(userDataDir);
  try {
    const page = await openReview(app, seeded.taskId);
    await expect(page.getByText("第 1 / 3 页")).toBeVisible();
    await expect(page.locator(".al-result-item")).toHaveCount(100);
    await page.getByRole("button", { name: "下一页" }).click();
    await expect(page.getByText("第 2 / 3 页")).toBeVisible();
    await page.getByRole("button", { name: "下一页" }).click();
    await expect(page.getByText("第 3 / 3 页")).toBeVisible();
    await expect(page.locator(".al-result-item")).toHaveCount(1);
    await expect(page.locator(`[data-occurrence-id="${seeded.occurrenceIds[200]}"]`)).toBeVisible();
  } finally {
    await closeApp(app);
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("E2E-02：1000 条 UI 分页、校对持久化和导出与数据库 ID 集合一致", async () => {
  const userDataDir = await makeOwnedUserData();
  const seeded = await seedReviewTask(userDataDir, 1000);
  let app = await launchDesktop(userDataDir);
  try {
    let page = await openReview(app, seeded.taskId);
    const renderedIds: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      renderedIds.push(...await page.locator(".al-result-item").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-occurrence-id"))));
      if (index < 9) {
        await page.getByRole("button", { name: "下一页" }).click();
        await expect(page.getByText(`第 ${index + 2} / 10 页`)).toBeVisible();
      }
    }
    expect(renderedIds).toEqual(seeded.occurrenceIds);
    expect(new Set(renderedIds).size).toBe(1000);

    await page.getByRole("button", { name: "首页" }).click();
    await page.locator(".al-result-item").first().click();
    await page.getByRole("textbox", { name: "校对备注" }).fill("自动保存备注：重启后仍应存在");
    await expect(page.locator(".al-save-state")).toHaveText("已自动保存");
    await page.getByRole("button", { name: /确认命中 \(A\)/ }).click();
    await expect(page.getByText("已校对 1 · 未校对 999")).toBeVisible();
    await page.getByRole("button", { name: "下一页" }).click();
    await page.locator(".al-result-item").first().click();
    await page.getByRole("button", { name: /需要复核 \(S\)/ }).click();
    await expect(page.getByText("已校对 2 · 未校对 998")).toBeVisible();

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
  let app = await launchDesktop(userDataDir);
  try {
    let page = await openReview(app, seeded.taskId);
    await page.getByRole("link", { name: "设置" }).click();
    await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
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
    await expect.poll(async () => page.locator(".al-review").evaluate((element) => (element as HTMLElement).style.getPropertyValue("--al-review-highlight"))).toBe("rgba(140, 98, 184, 0.18)");

    await page.getByRole("link", { name: "设置" }).click();
    await page.getByRole("tab", { name: "指定任务" }).click();
    await page.getByRole("button", { name: "恢复跟随全局" }).click();
    await page.getByRole("link", { name: "校对" }).click();
    await expect.poll(async () => page.locator(".al-review").evaluate((element) => (element as HTMLElement).style.getPropertyValue("--al-review-highlight"))).toBe("rgba(39, 139, 199, 0.18)");
  } finally {
    await closeApp(app);
    await rm(userDataDir, { recursive: true, force: true });
  }
});
