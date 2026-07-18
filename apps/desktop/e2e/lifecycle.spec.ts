import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { access, copyFile, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TOTAL_PAGES = 20;
const SEARCH_TEXT = "档案";
const SOURCE_ID = "source-main";
const APP_DIR = path.resolve(__dirname, "..");
const ENGINE_SRC = path.resolve(APP_DIR, "..", "..", "engine", "src");
const PREFLIGHT_FIXTURE = path.resolve(APP_DIR, "..", "..", "tests", "fixtures", "offline-formats", "simplified-horizontal.png");
const RUN_ID = (process.env["ARCHIVELENS_TEST_RUN_ID"] ?? "a11-local").replace(/[^A-Za-z0-9._-]/g, "-");

async function makeOwnedTempDir(kind: "source" | "userData", label = "run"): Promise<string> {
  const family = kind === "source" ? "archivelens-ocr-temp" : "archivelens-e2e-userdata";
  const dir = await mkdtemp(path.join(os.tmpdir(), `${family}-${RUN_ID}-${label}-`));
  await writeFile(path.join(dir, ".archivelens-test-owned"), `${RUN_ID}\n`, "utf8");
  return dir;
}

test.beforeAll(async () => {
  const resultRoot = path.join(APP_DIR, "test-results");
  await mkdir(resultRoot, { recursive: true });
  await writeFile(path.join(resultRoot, ".archivelens-runid"), `${RUN_ID}\n`, "utf8");
});

interface TaskState {
  task_id: string;
  status: string;
  processed_pages: number;
  total_pages: number;
  occurrence_count: number;
  search_terms_json?: string;
  search_mode?: string;
  error_code?: string | null;
  error_message?: string | null;
}

interface CheckpointState {
  task_id: string;
  source_id: string;
  last_completed_page: number;
  next_page: number;
  processed_page_ids: number[];
  worker_generation: number;
  updated_at: string;
}

interface TaskEventState {
  sequence: number;
  type: string;
  worker_generation: number;
}

interface PersistedTaskSnapshot {
  task: TaskState | null;
  processed_page_ids: number[];
  occurrence_ids: string[];
  checkpoint: CheckpointState | null;
  events: TaskEventState[];
  duplicate_occurrence_keys: string[];
}

interface WindowState {
  exists: boolean;
  visible: boolean;
  focused: boolean;
  minimized: boolean;
}

interface LaunchOptions {
  userDataDir: string;
  shutdownTimeoutMs?: number;
  extraEnv?: Record<string, string>;
}

let cachedPythonExecutable: Promise<string> | null = null;

async function resolvePythonExecutable(): Promise<string> {
  if (cachedPythonExecutable) {
    return cachedPythonExecutable;
  }

  cachedPythonExecutable = (async () => {
    const explicit = process.env["ARCHIVELENS_E2E_PYTHON"];
    if (explicit) {
      await access(explicit);
      return explicit;
    }

    const userProfile = process.env["USERPROFILE"];
    if (userProfile) {
      const versionsRoot = path.join(userProfile, ".pyenv", "pyenv-win", "versions");
      try {
        const entries = await readdir(versionsRoot, { withFileTypes: true });
        const candidates = entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.join(versionsRoot, entry.name, "python.exe"))
          .sort()
          .reverse();
        for (const candidate of candidates) {
          try {
            await access(candidate);
            return candidate;
          } catch {
            // continue
          }
        }
      } catch {
        // continue
      }
    }

    throw new Error("无法解析可执行的 python.exe；请设置 ARCHIVELENS_E2E_PYTHON");
  })();

  return cachedPythonExecutable;
}

async function launchDesktop({ userDataDir, shutdownTimeoutMs, extraEnv = {} }: LaunchOptions): Promise<ElectronApplication> {
  const pythonExe = await resolvePythonExecutable();
  return electron.launch({
    args: [APP_DIR],
    cwd: APP_DIR,
    env: {
      ...process.env,
      ARCHIVELENS_E2E: "1",
      ARCHIVELENS_USER_DATA_DIR: userDataDir,
      AL_DEBUG: "1",
      AL_ENGINE_DEV: pythonExe,
      AL_ENGINE_SRC: ENGINE_SRC,
      AL_SLOWFAKE_PAGES: String(TOTAL_PAGES),
      ...(shutdownTimeoutMs ? { ARCHIVELENS_E2E_SHUTDOWN_TIMEOUT_MS: String(shutdownTimeoutMs) } : {}),
      ...extraEnv,
    },
  });
}

async function waitForSidecar(win: Page): Promise<void> {
  await expect
    .poll(async () => {
      return win.evaluate(async () => {
        const env = await (window as any).archiveLens.app.getEnvironment();
        return Boolean(env?.sidecarReady);
      });
    })
    .toBe(true);
}

async function firstWindow(app: ElectronApplication): Promise<Page> {
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await waitForSidecar(win);
  return win;
}

async function createSlowFakeTask(win: Page, sourceDir: string): Promise<string> {
  // Slowfake only replaces OCR execution.  The product's folder preflight must
  // still inspect a genuine supported source instead of accepting an empty dir.
  await copyFile(PREFLIGHT_FIXTURE, path.join(sourceDir, "e2e-source.png"));
  return win.evaluate(async (dir) => {
    const api = (window as any).archiveLens;
    const task = await api.tasks.create({ source_dir: dir, search_text: "档案" });
    await api.tasks.start(task.task_id);
    window.location.hash = `#/tasks/${task.task_id}`;
    return task.task_id as string;
  }, sourceDir);
}

async function getTaskState(win: Page, taskId: string): Promise<TaskState> {
  return win.evaluate(async (id) => {
    return (window as any).archiveLens.test.task.getState(id);
  }, taskId);
}

async function getProcessedPageIds(win: Page, taskId: string): Promise<number[]> {
  const result = await win.evaluate(async (id) => {
    return (window as any).archiveLens.test.task.getProcessedPageIds(id);
  }, taskId);
  return result.processed_page_ids as number[];
}

async function getOccurrenceIds(win: Page, taskId: string): Promise<string[]> {
  const result = await win.evaluate(async (id) => {
    return (window as any).archiveLens.test.task.getOccurrenceIds(id);
  }, taskId);
  return result.occurrence_ids as string[];
}

async function getCheckpoint(win: Page, taskId: string): Promise<CheckpointState | null> {
  const result = await win.evaluate(async (id) => {
    return (window as any).archiveLens.test.task.getCheckpoint(id);
  }, taskId);
  return (result.checkpoint ?? null) as CheckpointState | null;
}

async function getEventSequence(win: Page, taskId: string): Promise<TaskEventState[]> {
  const result = await win.evaluate(async (id) => {
    return (window as any).archiveLens.test.task.getEventSequence(id);
  }, taskId);
  return result.events as TaskEventState[];
}

async function getWindowState(win: Page): Promise<WindowState> {
  return win.evaluate(async () => {
    return (window as any).archiveLens.test.window.getState();
  });
}

async function getEnginePid(win: Page): Promise<number | null> {
  const result = await win.evaluate(async () => {
    return (await (window as any).archiveLens.test.engine.getPid()).pid as number | null;
  });
  return result;
}

async function requestClose(win: Page) {
  return win.evaluate(async () => {
    return (window as any).archiveLens.test.lifecycle.requestClose();
  });
}

async function triggerNativeClose(app: ElectronApplication, dialogResponse: number): Promise<void> {
  await app.evaluate(
    async ({ BrowserWindow, dialog }, response) => {
      (dialog as any).showMessageBox = async () => ({ response, checkboxChecked: false });
      BrowserWindow.getAllWindows()[0]?.close();
    },
    dialogResponse,
  );
}

async function selectCloseAction(
  win: Page,
  action: "minimize" | "cancel" | "pause_and_quit" | "stop_and_quit" | "continue_waiting" | "force_quit",
) {
  return win.evaluate(async (nextAction) => {
    return (window as any).archiveLens.test.lifecycle.selectCloseAction({ action: nextAction });
  }, action);
}

async function restoreWindow(win: Page) {
  return win.evaluate(async () => {
    return (window as any).archiveLens.test.tray.restoreWindow();
  });
}

async function waitForProcessedAtLeast(win: Page, taskId: string, pageNo: number, timeoutMs = 20_000): Promise<number[]> {
  await expect.poll(async () => {
    const ids = await getProcessedPageIds(win, taskId);
    return ids[ids.length - 1] ?? 0;
  }, { timeout: timeoutMs, intervals: [50, 100, 100, 100] }).toBeGreaterThanOrEqual(pageNo);
  return getProcessedPageIds(win, taskId);
}

async function waitForTaskStatus(win: Page, taskId: string, status: string): Promise<TaskState> {
  await expect.poll(async () => (await getTaskState(win, taskId)).status).toBe(status);
  return getTaskState(win, taskId);
}

async function waitForTaskCompletion(win: Page, taskId: string): Promise<TaskState> {
  await expect.poll(async () => (await getTaskState(win, taskId)).status).toBe("completed");
  await expect.poll(() => getProcessedPageIds(win, taskId)).toEqual(Array.from({ length: TOTAL_PAGES }, (_value, index) => index + 1));
  return getTaskState(win, taskId);
}

async function waitForProgressIncrease(win: Page, taskId: string, baseline: number): Promise<number[]> {
  await expect.poll(async () => (await getProcessedPageIds(win, taskId)).length).toBeGreaterThan(baseline);
  return getProcessedPageIds(win, taskId);
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDuplicateNumbers(ids: number[]): number[] {
  const seen = new Set<number>();
  const duplicates = new Set<number>();
  for (const id of ids) {
    if (seen.has(id)) {
      duplicates.add(id);
    }
    seen.add(id);
  }
  return [...duplicates].sort((left, right) => left - right);
}

function getDuplicateStrings(ids: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      duplicates.add(id);
    }
    seen.add(id);
  }
  return [...duplicates].sort();
}

function getMissingPages(ids: number[], totalPages = TOTAL_PAGES): number[] {
  const pageSet = new Set(ids);
  return Array.from({ length: totalPages }, (_value, index) => index + 1).filter((pageNo) => !pageSet.has(pageNo));
}

function assertStrictlyIncreasing(events: TaskEventState[]): void {
  for (let index = 1; index < events.length; index += 1) {
    expect(events[index]!.sequence).toBeGreaterThan(events[index - 1]!.sequence);
  }
}

function getAppProcessPid(app: ElectronApplication): number | null {
  const proc = (app as any).process?.();
  return typeof proc?.pid === "number" ? proc.pid : null;
}

async function isPidRunning(pid: number): Promise<boolean> {
  const { stdout } = await execFileAsync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
    windowsHide: true,
  });
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0 || lines.every((line) => line.startsWith("INFO:"))) {
    return false;
  }
  return lines.some((line) => {
    const match = /^"[^"]+","(\d+)"/.exec(line);
    return Number(match?.[1] ?? 0) === pid;
  });
}

async function waitForPidExit(pid: number | null, timeoutMs = 40_000): Promise<void> {
  if (!pid) {
    return;
  }
  await expect.poll(() => isPidRunning(pid), { timeout: timeoutMs }).toBe(false);
}

function getDbPath(userDataDir: string): string {
  return path.join(userDataDir, "engine", "archivelens.db");
}

async function readPersistedTaskSnapshot(userDataDir: string, taskId: string): Promise<PersistedTaskSnapshot> {
  const pythonExe = await resolvePythonExecutable();
  const dumpScript = [
    "import json, sqlite3, sys",
    "db_path, task_id, source_id = sys.argv[1:4]",
    "conn = sqlite3.connect(db_path)",
    "conn.row_factory = sqlite3.Row",
    "def row_to_dict(row):",
    "    return dict(row) if row is not None else None",
    "task = row_to_dict(conn.execute('SELECT * FROM tasks WHERE task_id=?', (task_id,)).fetchone())",
    "processed_page_ids = [int(r['page_no']) for r in conn.execute('SELECT page_no FROM task_processed_pages WHERE task_id=? AND source_id=? ORDER BY page_no', (task_id, source_id)).fetchall()]",
    "occurrence_rows = conn.execute('SELECT occurrence_id, source_id, page_number, matched_text, bbox_hash FROM occurrences WHERE task_id=? ORDER BY occurrence_id', (task_id,)).fetchall()",
    "occurrence_ids = [r['occurrence_id'] for r in occurrence_rows]",
    "seen = set()",
    "duplicate_keys = []",
    "for row in occurrence_rows:",
    "    key = '|'.join([str(row['source_id'] or ''), str(row['page_number'] or ''), str(row['matched_text'] or ''), str(row['bbox_hash'] or '')])",
    "    if key in seen and key not in duplicate_keys:",
    "        duplicate_keys.append(key)",
    "    seen.add(key)",
    "checkpoint = row_to_dict(conn.execute('SELECT task_id, source_id, last_completed_page, next_page, processed_page_ids_json, worker_generation, updated_at FROM task_checkpoints WHERE task_id=? AND source_id=?', (task_id, source_id)).fetchone())",
    "if checkpoint is not None:",
    "    checkpoint['processed_page_ids'] = json.loads(checkpoint.pop('processed_page_ids_json') or '[]')",
    "events = [",
    "    {",
    "        'sequence': int(row['sequence']),",
    "        'type': row['event_type'],",
    "        'worker_generation': int(row['worker_generation'] or 0),",
    "    }",
    "    for row in conn.execute('SELECT sequence, event_type, worker_generation FROM task_events WHERE task_id=? ORDER BY sequence', (task_id,)).fetchall()",
    "]",
    "print(json.dumps({",
    "    'task': task,",
    "    'processed_page_ids': processed_page_ids,",
    "    'occurrence_ids': occurrence_ids,",
    "    'checkpoint': checkpoint,",
    "    'events': events,",
    "    'duplicate_occurrence_keys': duplicate_keys,",
    "}, ensure_ascii=False))",
  ].join("\n");

  const { stdout } = await execFileAsync(pythonExe, ["-c", dumpScript, getDbPath(userDataDir), taskId, SOURCE_ID], {
    windowsHide: true,
  });
  return JSON.parse(stdout.trim()) as PersistedTaskSnapshot;
}

function assertIntegrity(snapshot: PersistedTaskSnapshot): void {
  expect(snapshot.processed_page_ids).toEqual(Array.from({ length: TOTAL_PAGES }, (_value, index) => index + 1));
  expect(getDuplicateNumbers(snapshot.processed_page_ids)).toEqual([]);
  expect(getMissingPages(snapshot.processed_page_ids)).toEqual([]);
  expect(getDuplicateStrings(snapshot.occurrence_ids)).toEqual([]);
  expect(snapshot.duplicate_occurrence_keys).toEqual([]);
  expect(snapshot.occurrence_ids).toHaveLength(TOTAL_PAGES);
  expect(snapshot.task.search_terms_json).toBe(JSON.stringify([SEARCH_TEXT]));
  expect(snapshot.task.search_mode).toBe("exact_literal");
  assertStrictlyIncreasing(snapshot.events);
}

async function navigateToTask(win: Page, taskId: string): Promise<void> {
  await win.evaluate((id) => {
    window.location.hash = `#/tasks/${id}`;
  }, taskId);
  await expect(win.getByRole("heading", { name: "扫描任务" })).toBeVisible();
}

async function restartAndResumeTask(userDataDir: string, taskId: string, previousEnginePid: number | null): Promise<PersistedTaskSnapshot> {
  const app = await launchDesktop({ userDataDir });
  let win: Page | undefined;
  try {
    win = await firstWindow(app);
    await expect(win.getByText(/发现 1 个未完成任务/)).toBeVisible();
    await win.getByRole("button", { name: "查看", exact: true }).click();
    await navigateToTask(win, taskId);
    await expect(win.getByRole("button", { name: "继续" })).toBeVisible();

    const resumedEnginePid = await getEnginePid(win);
    if (previousEnginePid !== null) {
      expect(resumedEnginePid).not.toBe(previousEnginePid);
    }

    await win.getByRole("button", { name: "继续" }).click();
    await waitForTaskCompletion(win, taskId);

    const snapshot = await readPersistedTaskSnapshot(userDataDir, taskId);
    assertIntegrity(snapshot);
    return snapshot;
  } finally {
    if (win) {
      await closeAppForceQuit(app, win);
    } else {
      await app.close().catch(() => undefined);
    }
  }
}

async function runPauseResumeScenario(pausePage: number, attempt = 1): Promise<PersistedTaskSnapshot> {
  const sourceDir = await makeOwnedTempDir("source", `pause-${pausePage}`);
  const userDataDir = await makeOwnedTempDir("userData", `pause-${pausePage}`);
  await mkdir(sourceDir, { recursive: true });

  const firstApp = await launchDesktop({
    userDataDir,
    extraEnv: {
      AL_SLOWFAKE_PAGE_DELAY_MS: "350",
      AL_SLOWFAKE_INTER_PAGE_DELAY_MS: pausePage >= 19 ? "1000" : "200",
    },
  });
  const firstWin = await firstWindow(firstApp);
  const taskId = await createSlowFakeTask(firstWin, sourceDir);
  const firstAppPid = getAppProcessPid(firstApp);
  const firstEnginePid = await getEnginePid(firstWin);

  await waitForProcessedAtLeast(firstWin, taskId, pausePage, pausePage >= 19 ? 45_000 : 20_000);
  const statusBeforePause = await getTaskState(firstWin, taskId);
  if (statusBeforePause.status === "completed") {
    await closeAppForceQuit(firstApp, firstWin);
    if (attempt >= 2) {
      throw new Error(`page ${pausePage} 在发起暂停前已自然完成`);
    }
    return runPauseResumeScenario(pausePage, attempt + 1);
  }
  const checkpointBeforeExit = await getCheckpoint(firstWin, taskId);
  const processedAtPauseRequest = await getProcessedPageIds(firstWin, taskId);
  const maxSequenceBeforeExit = Math.max(...(await getEventSequence(firstWin, taskId)).map((event) => event.sequence));

  await requestClose(firstWin);
  await selectCloseAction(firstWin, "pause_and_quit").catch(() => ({ outcome: "quit" }));
  await waitForPidExit(firstAppPid);
  await waitForPidExit(firstEnginePid);

  const snapshotAfterExit = await readPersistedTaskSnapshot(userDataDir, taskId);
  if (snapshotAfterExit.task?.status === "completed") {
    if (attempt >= 2) {
      throw new Error(`page ${pausePage} 在暂停请求到达前连续自然完成`);
    }
    return runPauseResumeScenario(pausePage, attempt + 1);
  }

  const resumedSnapshot = await restartAndResumeTask(userDataDir, taskId, firstEnginePid);
  expect(resumedSnapshot.task?.status).toBe("completed");
  expect(resumedSnapshot.events[resumedSnapshot.events.length - 1]!.sequence).toBeGreaterThan(maxSequenceBeforeExit);
  expect(Math.max(...resumedSnapshot.events.map((event) => event.worker_generation))).toBeGreaterThan(
    checkpointBeforeExit?.worker_generation ?? 0,
  );
  expect(resumedSnapshot.processed_page_ids.slice(0, processedAtPauseRequest.length)).toEqual(processedAtPauseRequest);
  const resumeStart = resumedSnapshot.processed_page_ids.find((pageNo) => pageNo > (checkpointBeforeExit?.last_completed_page ?? 0));
  expect(resumeStart).toBe(checkpointBeforeExit?.next_page);
  return resumedSnapshot;
}

async function armEngineExitCapture(win: Page): Promise<void> {
  await win.evaluate(() => {
    const target = window as any;
    if (target.__archivelensEngineExitCapture) {
      return;
    }
    target.__archivelensEngineExitCapture = [];
    target.__archivelensEngineExitDispose = window.archiveLens.subscribe.onEngineExit((info: unknown) => {
      target.__archivelensEngineExitCapture.push(info);
    });
  });
}

async function getCapturedEngineExits(win: Page): Promise<any[]> {
  return win.evaluate(() => {
    return ((window as any).__archivelensEngineExitCapture ?? []) as any[];
  });
}

async function closeAppForceQuit(app: ElectronApplication, win: Page): Promise<void> {
  const appPid = getAppProcessPid(app);
  try {
    await requestClose(win);
    void selectCloseAction(win, "force_quit").catch(() => undefined);
  } catch {
    // ignore
  }
  await waitForPidExit(appPid);
  await app.close().catch(() => undefined);
}

test("Lifecycle: native window close keeps the task running and restores from tray", async () => {
  const sourceDir = await makeOwnedTempDir("source", "native-close");
  const userDataDir = await makeOwnedTempDir("userData", "native-close");
  await mkdir(sourceDir, { recursive: true });

  let app: ElectronApplication | undefined;
  let win: Page | undefined;
  try {
    app = await launchDesktop({ userDataDir });
    win = await firstWindow(app);

    const taskId = await createSlowFakeTask(win, sourceDir);
    await waitForProcessedAtLeast(win, taskId, 3);

    const pidBefore = await getEnginePid(win);
    expect(pidBefore).not.toBeNull();

    await triggerNativeClose(app, 0);

    await expect.poll(() => getWindowState(win)).toMatchObject({ exists: true, visible: false });
    const pagesBefore = (await getProcessedPageIds(win, taskId)).length;
    await waitForProgressIncrease(win, taskId, pagesBefore);

    const restored = await restoreWindow(win);
    expect(restored.restored).toBe(true);
    await expect.poll(() => getWindowState(win)).toMatchObject({ exists: true, visible: true, focused: true });

    expect(await getEnginePid(win)).toBe(pidBefore);
    expect((await getTaskState(win, taskId)).status).toBe("running");
  } finally {
    if (app && win) {
      await closeAppForceQuit(app, win);
    }
  }
});

test("Lifecycle: tray minimize keeps task running and tray restore returns the window", async () => {
  const sourceDir = await makeOwnedTempDir("source");
  const userDataDir = await makeOwnedTempDir("userData");
  await mkdir(sourceDir, { recursive: true });

  let app: ElectronApplication | undefined;
  let win: Page | undefined;
  try {
    app = await launchDesktop({ userDataDir });
    win = await firstWindow(app);

    const taskId = await createSlowFakeTask(win, sourceDir);
    await waitForProcessedAtLeast(win, taskId, 3);

    const pidBefore = await getEnginePid(win);
    expect(pidBefore).not.toBeNull();

    const request = await requestClose(win);
    expect(request.requiresAction).toBe(true);

    const minimized = await selectCloseAction(win, "minimize");
    expect(minimized.outcome).toBe("minimized");

    await expect.poll(() => getWindowState(win)).toMatchObject({ visible: false });
    const pagesBefore = (await getProcessedPageIds(win, taskId)).length;
    await waitForProgressIncrease(win, taskId, pagesBefore);

    const restored = await restoreWindow(win);
    expect(restored.restored).toBe(true);
    await expect.poll(() => getWindowState(win)).toMatchObject({ visible: true, focused: true });

    const pidAfter = await getEnginePid(win);
    expect(pidAfter).toBe(pidBefore);
    expect((await getTaskState(win, taskId)).status).toBe("running");
  } finally {
    if (app && win) {
      await closeAppForceQuit(app, win);
    }
  }
});

test("Lifecycle: cancel close keeps the window open and allows a second close request", async () => {
  const sourceDir = await makeOwnedTempDir("source");
  const userDataDir = await makeOwnedTempDir("userData");
  await mkdir(sourceDir, { recursive: true });

  let app: ElectronApplication | undefined;
  let win: Page | undefined;
  try {
    app = await launchDesktop({ userDataDir });
    win = await firstWindow(app);

    const taskId = await createSlowFakeTask(win, sourceDir);
    await waitForProcessedAtLeast(win, taskId, 3);

    const firstRequest = await requestClose(win);
    expect(firstRequest.requiresAction).toBe(true);
    const cancelled = await selectCloseAction(win, "cancel");
    expect(cancelled.outcome).toBe("cancelled");

    const pagesBefore = (await getProcessedPageIds(win, taskId)).length;
    await waitForProgressIncrease(win, taskId, pagesBefore);

    const secondRequest = await requestClose(win);
    expect(secondRequest.requiresAction).toBe(true);
    const stateAfterSecondRequest = await win.evaluate(async () => {
      return (window as any).archiveLens.test.lifecycle.getState();
    });
    expect(stateAfterSecondRequest.shutdownFlowRunning).toBe(true);
  } finally {
    if (app && win) {
      await closeAppForceQuit(app, win);
    }
  }
});

test("Lifecycle: pause and exit persists checkpoint and leaves no residual process", async () => {
  const sourceDir = await makeOwnedTempDir("source");
  const userDataDir = await makeOwnedTempDir("userData");
  await mkdir(sourceDir, { recursive: true });

  const app = await launchDesktop({ userDataDir });
  const win = await firstWindow(app);
  const taskId = await createSlowFakeTask(win, sourceDir);
  const appPid = getAppProcessPid(app);
  const enginePid = await getEnginePid(win);

  const processedAtPauseRequest = await waitForProcessedAtLeast(win, taskId, 3);
  const occurrencesAtPauseRequest = await getOccurrenceIds(win, taskId);

  await requestClose(win);
  const outcome = await selectCloseAction(win, "pause_and_quit").catch(() => ({ outcome: "quit" }));
  expect(outcome.outcome).toBe("quit");
  await waitForPidExit(appPid);
  await waitForPidExit(enginePid);

  const snapshot = await readPersistedTaskSnapshot(userDataDir, taskId);
  expect(snapshot.task?.status).toBe("paused");
  expect(snapshot.processed_page_ids.slice(0, processedAtPauseRequest.length)).toEqual(processedAtPauseRequest);
  expect(snapshot.occurrence_ids.length).toBe(snapshot.processed_page_ids.length);
  expect(snapshot.occurrence_ids.length).toBeGreaterThanOrEqual(occurrencesAtPauseRequest.length);
  expect(snapshot.checkpoint?.last_completed_page).toBe(snapshot.processed_page_ids[snapshot.processed_page_ids.length - 1]);
  expect(snapshot.checkpoint?.next_page).toBe((snapshot.processed_page_ids[snapshot.processed_page_ids.length - 1] ?? 0) + 1);
  expect(snapshot.checkpoint?.processed_page_ids).toEqual(snapshot.processed_page_ids);
  expect(snapshot.events.map((event) => event.type)).toContain("task.pausing");
  expect(snapshot.events.map((event) => event.type)).toContain("task.paused");
  assertStrictlyIncreasing(snapshot.events);

  const pausing = snapshot.events.find((event) => event.type === "task.pausing");
  const paused = snapshot.events.find((event) => event.type === "task.paused");
  expect(pausing).toBeDefined();
  expect(paused).toBeDefined();
  expect(paused!.sequence).toBeGreaterThan(pausing!.sequence);
});

test("Lifecycle: restart recover resumes from checkpoint without duplicates or missing pages", async () => {
  const sourceDir = await makeOwnedTempDir("source");
  const userDataDir = await makeOwnedTempDir("userData");
  await mkdir(sourceDir, { recursive: true });

  const firstApp = await launchDesktop({ userDataDir });
  const firstWin = await firstWindow(firstApp);
  const taskId = await createSlowFakeTask(firstWin, sourceDir);
  const firstAppPid = getAppProcessPid(firstApp);
  const firstEnginePid = await getEnginePid(firstWin);
  await waitForProcessedAtLeast(firstWin, taskId, 3);
  const checkpointBeforeExit = await getCheckpoint(firstWin, taskId);
  const eventsBeforeExit = await getEventSequence(firstWin, taskId);
  const maxSequenceBeforeExit = Math.max(...eventsBeforeExit.map((event) => event.sequence));

  await requestClose(firstWin);
  await selectCloseAction(firstWin, "pause_and_quit").catch(() => ({ outcome: "quit" }));
  await waitForPidExit(firstAppPid);
  await waitForPidExit(firstEnginePid);

  const secondApp = await launchDesktop({ userDataDir });
  let secondWin: Page | undefined;
  try {
    secondWin = await firstWindow(secondApp);
    await expect(secondWin.getByText(/发现 1 个未完成任务/)).toBeVisible();
    await secondWin.getByRole("button", { name: "查看", exact: true }).click();
    await navigateToTask(secondWin, taskId);
    await expect(secondWin.getByRole("button", { name: "继续" })).toBeVisible();

    const resumedEnginePid = await getEnginePid(secondWin);
    expect(resumedEnginePid).not.toBe(firstEnginePid);

    await secondWin.getByRole("button", { name: "继续" }).click();
    await waitForTaskCompletion(secondWin, taskId);

    const finalEvents = await getEventSequence(secondWin, taskId);
    assertStrictlyIncreasing(finalEvents);
    expect(finalEvents[finalEvents.length - 1]!.sequence).toBeGreaterThan(maxSequenceBeforeExit);
    expect(Math.max(...finalEvents.map((event) => event.worker_generation))).toBeGreaterThan(
      checkpointBeforeExit?.worker_generation ?? 0,
    );

    const finalState = await getTaskState(secondWin, taskId);
    expect(finalState.status).toBe("completed");
    expect(finalState.processed_pages).toBe(TOTAL_PAGES);

    const processed = await getProcessedPageIds(secondWin, taskId);
    const resumeStart = processed.find((pageNo) => pageNo > (checkpointBeforeExit?.last_completed_page ?? 0));
    expect(resumeStart).toBe(checkpointBeforeExit?.next_page);

    const appInfo = await secondWin.evaluate(async () => {
      return (window as any).archiveLens.app.getInfo();
    });
    expect(appInfo.protocol_version).toBe(3);

    const snapshot = await readPersistedTaskSnapshot(userDataDir, taskId);
    assertIntegrity(snapshot);
  } finally {
    if (secondWin) {
      await closeAppForceQuit(secondApp, secondWin);
    } else {
      await secondApp.close().catch(() => undefined);
    }
  }
});

test("Lifecycle: stop and exit keeps cancelled history and does not auto-recover", async () => {
  const sourceDir = await makeOwnedTempDir("source");
  const userDataDir = await makeOwnedTempDir("userData");
  await mkdir(sourceDir, { recursive: true });

  const firstApp = await launchDesktop({ userDataDir });
  const firstWin = await firstWindow(firstApp);
  const taskId = await createSlowFakeTask(firstWin, sourceDir);
  const firstAppPid = getAppProcessPid(firstApp);
  const enginePid = await getEnginePid(firstWin);
  await waitForProcessedAtLeast(firstWin, taskId, 3);

  await requestClose(firstWin);
  await Promise.race([selectCloseAction(firstWin, "stop_and_quit").catch(() => undefined), delayMs(1000)]);
  await waitForPidExit(firstAppPid);
  await waitForPidExit(enginePid);

  const snapshot = await readPersistedTaskSnapshot(userDataDir, taskId);
  expect(snapshot.task?.status).toBe("cancelled");
  expect(snapshot.processed_page_ids.length).toBeGreaterThanOrEqual(3);
  expect(snapshot.processed_page_ids.length).toBeLessThan(TOTAL_PAGES);
  expect(snapshot.checkpoint?.last_completed_page).toBe(snapshot.processed_page_ids[snapshot.processed_page_ids.length - 1]);

  const secondApp = await launchDesktop({ userDataDir });
  let secondWin: Page | undefined;
  try {
    secondWin = await firstWindow(secondApp);
    await expect(secondWin.getByText(/发现 \d+ 个未完成任务/)).toHaveCount(0);
    await navigateToTask(secondWin, taskId);
    await expect.poll(async () => (await getTaskState(secondWin!, taskId)).status).toBe("cancelled");
    await expect(secondWin.getByRole("button", { name: "继续" })).toHaveCount(0);
  } finally {
    if (secondWin) {
      await closeAppForceQuit(secondApp, secondWin);
    } else {
      await secondApp.close().catch(() => undefined);
    }
  }
});

test("Lifecycle: sidecar crash is recoverable after relaunch and resume preserves integrity", async () => {
  const sourceDir = await makeOwnedTempDir("source");
  const userDataDir = await makeOwnedTempDir("userData");
  await mkdir(sourceDir, { recursive: true });

  const firstApp = await launchDesktop({ userDataDir });
  const firstWin = await firstWindow(firstApp);
  const taskId = await createSlowFakeTask(firstWin, sourceDir);
  await armEngineExitCapture(firstWin);

  const enginePidBeforeCrash = await getEnginePid(firstWin);
  await waitForProcessedAtLeast(firstWin, taskId, 3);
  const eventsBeforeCrash = await getEventSequence(firstWin, taskId);
  const maxSequenceBeforeCrash = Math.max(...eventsBeforeCrash.map((event) => event.sequence));

  const crashResult = await firstWin.evaluate(async () => {
    return (window as any).archiveLens.test.sidecar.simulateCrash();
  });
  expect(crashResult.ok).toBe(true);

  await expect.poll(async () => (await getCapturedEngineExits(firstWin)).length).toBeGreaterThan(0);
  const engineExitEvents = await getCapturedEngineExits(firstWin);
  expect(String(engineExitEvents[0]?.kind ?? "")).toMatch(/unexpected_exit|crash/);
  await expect.poll(async () => {
    const state = await getTaskState(firstWin, taskId).catch(() => null);
    return state?.status ?? "engine_down";
  }).toBe("engine_down");

  await firstApp.close().catch(() => undefined);
  await waitForPidExit(enginePidBeforeCrash);

  const crashedSnapshot = await readPersistedTaskSnapshot(userDataDir, taskId);
  expect(crashedSnapshot.task?.status).toMatch(/recoverable|running|pausing/);

  const secondApp = await launchDesktop({ userDataDir });
  let secondWin: Page | undefined;
  try {
    secondWin = await firstWindow(secondApp);
    await expect(secondWin.getByText(/发现 1 个未完成任务/)).toBeVisible();
    await secondWin.getByRole("button", { name: "查看", exact: true }).click();
    await navigateToTask(secondWin, taskId);
    await secondWin.getByRole("button", { name: "继续" }).click();
    await waitForTaskCompletion(secondWin, taskId);

    const resumedEnginePid = await getEnginePid(secondWin);
    expect(resumedEnginePid).not.toBe(enginePidBeforeCrash);

    const finalSnapshot = await readPersistedTaskSnapshot(userDataDir, taskId);
    assertIntegrity(finalSnapshot);
    expect(finalSnapshot.task?.status).toBe("completed");
    expect(finalSnapshot.events[finalSnapshot.events.length - 1]!.sequence).toBeGreaterThan(maxSequenceBeforeCrash);
  } finally {
    if (secondWin) {
      await closeAppForceQuit(secondApp, secondWin);
    } else {
      await secondApp.close().catch(() => undefined);
    }
  }
});

for (const pausePage of [1, 3, 10, 19]) {
  test(`Lifecycle: pause/resume at page ${pausePage} preserves checkpoint integrity`, async () => {
    const snapshot = await runPauseResumeScenario(pausePage);
    expect(snapshot.task?.processed_pages).toBe(TOTAL_PAGES);
  });
}

test("Lifecycle: continue waiting completes pause-and-quit without duplicate pause requests", async () => {
  const sourceDir = await makeOwnedTempDir("source", "timeout-wait");
  const userDataDir = await makeOwnedTempDir("userData", "timeout-wait");
  await mkdir(sourceDir, { recursive: true });

  const app = await launchDesktop({
    userDataDir,
    shutdownTimeoutMs: 500,
    extraEnv: { AL_SLOWFAKE_PAUSE_TRANSITION_DELAY_MS: "700" },
  });
  const win = await firstWindow(app);
  const taskId = await createSlowFakeTask(win, sourceDir);
  const appPid = getAppProcessPid(app);
  const enginePid = await getEnginePid(win);

  await waitForProcessedAtLeast(win, taskId, 3);
  await requestClose(win);
  const timedOut = await selectCloseAction(win, "pause_and_quit");
  expect(timedOut.outcome).toBe("timed_out");

  await Promise.race([selectCloseAction(win, "continue_waiting").catch(() => undefined), delayMs(1000)]);
  await waitForPidExit(appPid);
  await waitForPidExit(enginePid);

  const snapshot = await readPersistedTaskSnapshot(userDataDir, taskId);
  expect(snapshot.task?.status).toBe("paused");
  expect(snapshot.events.filter((event) => event.type === "task.pausing")).toHaveLength(1);
  expect(snapshot.events.filter((event) => event.type === "task.paused")).toHaveLength(1);
});

test("Lifecycle: cancel timeout clears shutdown flow and task keeps running", async () => {
  const sourceDir = await makeOwnedTempDir("source", "timeout-cancel");
  const userDataDir = await makeOwnedTempDir("userData", "timeout-cancel");
  await mkdir(sourceDir, { recursive: true });

  const app = await launchDesktop({
    userDataDir,
    shutdownTimeoutMs: 500,
    extraEnv: { AL_SLOWFAKE_PAUSE_TRANSITION_DELAY_MS: "700" },
  });
  const win = await firstWindow(app);
  const taskId = await createSlowFakeTask(win, sourceDir);

  try {
    await waitForProcessedAtLeast(win, taskId, 3);
    const pagesBefore = (await getProcessedPageIds(win, taskId)).length;

    await requestClose(win);
    const timedOut = await selectCloseAction(win, "pause_and_quit");
    expect(timedOut.outcome).toBe("timed_out");

    const cancelled = await selectCloseAction(win, "cancel");
    expect(cancelled.outcome).toBe("cancelled");
    await expect.poll(async () => (await getTaskState(win, taskId)).status).toBe("running");
    await waitForProgressIncrease(win, taskId, pagesBefore);

    const lifecycleState = await win.evaluate(async () => {
      return (window as any).archiveLens.test.lifecycle.getState();
    });
    expect(lifecycleState.shutdownFlowRunning).toBe(false);

    const events = await getEventSequence(win, taskId);
    expect(events.filter((event) => event.type === "task.pausing")).toHaveLength(1);
  } finally {
    await closeAppForceQuit(app, win);
  }
});

test("Lifecycle: force quit after timeout yields recoverable resume on next launch", async () => {
  const sourceDir = await makeOwnedTempDir("source", "timeout-force");
  const userDataDir = await makeOwnedTempDir("userData", "timeout-force");
  await mkdir(sourceDir, { recursive: true });

  const firstApp = await launchDesktop({
    userDataDir,
    shutdownTimeoutMs: 500,
    extraEnv: { AL_SLOWFAKE_PAUSE_TRANSITION_DELAY_MS: "700" },
  });
  const firstWin = await firstWindow(firstApp);
  const taskId = await createSlowFakeTask(firstWin, sourceDir);
  const firstAppPid = getAppProcessPid(firstApp);
  const firstEnginePid = await getEnginePid(firstWin);

  await waitForProcessedAtLeast(firstWin, taskId, 3);
  await requestClose(firstWin);
  const timedOut = await selectCloseAction(firstWin, "pause_and_quit");
  expect(timedOut.outcome).toBe("timed_out");
  await selectCloseAction(firstWin, "force_quit").catch(() => ({ outcome: "quit" }));
  await waitForPidExit(firstAppPid);
  await waitForPidExit(firstEnginePid);

  const snapshot = await restartAndResumeTask(userDataDir, taskId, firstEnginePid);
  expect(snapshot.task?.status).toBe("completed");
});

test("Lifecycle: production mode does not expose the E2E bridge", async () => {
  const userDataDir = await makeOwnedTempDir("userData", "production");
  const pythonExe = await resolvePythonExecutable();
  const app = await electron.launch({
    args: [APP_DIR],
    cwd: APP_DIR,
    env: {
      ...process.env,
      ARCHIVELENS_USER_DATA_DIR: userDataDir,
      AL_DEBUG: "1",
      AL_ENGINE_DEV: pythonExe,
      AL_ENGINE_SRC: ENGINE_SRC,
      AL_SLOWFAKE_PAGES: String(TOTAL_PAGES),
    },
  });

  let win: Page | undefined;
  try {
    win = await firstWindow(app);
    const hasBridge = await win.evaluate(() => {
      return typeof (window as any).archiveLens.test !== "undefined";
    });
    expect(hasBridge).toBe(false);

    const initialUrl = win.url();
    const inlineScriptExecuted = await win.evaluate(async () => {
      (window as any).__archiveLensCspProbe = false;
      const script = document.createElement("script");
      script.textContent = "window.__archiveLensCspProbe = true";
      document.head.appendChild(script);
      await new Promise((resolve) => window.setTimeout(resolve, 50));
      return (window as any).__archiveLensCspProbe === true;
    });
    expect(inlineScriptExecuted).toBe(false);

    await win.evaluate(() => {
      window.location.href = "data:text/html,<title>untrusted</title>";
    });
    await win.waitForTimeout(500);
    expect(win.url()).toBe(initialUrl);
  } finally {
    if (win) {
      const appPid = getAppProcessPid(app);
      await app.close().catch(() => undefined);
      await waitForPidExit(appPid);
    } else {
      await app.close().catch(() => undefined);
    }
  }
});

test("Lifecycle: cleanup failure shows retry UI, hides normal actions, retry succeeds", async () => {
  const userDataDir = await makeOwnedTempDir("userData", "cleanup-ui");
  const sourceDir = await makeOwnedTempDir("source", "cleanup-ui");
  await writeFile(path.join(sourceDir, "source.txt"), "src", "utf8");
  const app = await launchDesktop({ userDataDir });
  try {
    const win = await firstWindow(app);
    const taskId = await createSlowFakeTask(win, sourceDir);
    await waitForTaskCompletion(win, taskId);

    // 在任务派生目录放入一个指向根外的 junction 子项，确定性诱导清理 fail-closed
    // （reparse 检测拒绝跟随；机密文件不得被删）。比文件锁更稳定可复现。
    const taskDir = path.join(userDataDir, "engine", "tasks", taskId);
    await mkdir(taskDir, { recursive: true });
    const outsideDir = path.join(userDataDir, "outside-secret");
    await mkdir(outsideDir, { recursive: true });
    await writeFile(path.join(outsideDir, "secret.txt"), "must-not-be-deleted", "utf8");
    const junctionChild = path.join(taskDir, "evil-link");
    await execFileAsync("cmd", ["/c", "mklink", "/J", junctionChild, outsideDir]);

    await win.getByRole("link", { name: "任务中心" }).click();
    // 删除前：completed 任务的主操作是“校对”
    await expect(win.getByRole("button", { name: "校对" })).toBeVisible();
    await win.getByRole("button", { name: /更多操作$/ }).first().click();
    await win.getByRole("menuitem", { name: "删除任务" }).click();
    const dialog = win.getByRole("dialog");
    await expect(dialog).toContainText("不会删除原始文件");
    await dialog.getByRole("button", { name: "删除任务" }).click();

    // 清理失败 UI：badge + 重试/打开按钮可见；普通“校对”入口已隐藏；无空“更多”菜单
    await expect(win.getByText("清理失败").first()).toBeVisible({ timeout: 15_000 });
    await expect(win.getByRole("button", { name: "重试清理" })).toBeVisible();
    await expect(win.getByRole("button", { name: "打开残留目录" })).toBeVisible();
    await expect(win.getByRole("button", { name: "校对" })).toHaveCount(0);
    await expect(win.getByRole("button", { name: /更多操作$/ })).toHaveCount(0);
    // fail closed：根外机密文件未被删除
    expect(await access(path.join(outsideDir, "secret.txt")).then(() => true, () => false)).toBe(true);

    // 移除 junction 子项后重试清理 → 任务从列表消失
    await execFileAsync("cmd", ["/c", "rmdir", junctionChild]);
    await win.getByRole("button", { name: "重试清理" }).click();
    await expect.poll(async () => {
      try {
        await win.evaluate(async (id) => { await (window as any).archiveLens.tasks.get(id); }, taskId);
        return false;
      } catch {
        return true;
      }
    }, { timeout: 15_000 }).toBe(true);
  } finally {
    await app.close().catch(() => undefined);
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(sourceDir, { recursive: true, force: true }).catch(() => undefined);
  }
});
