import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BuildMetadata } from "@shared/index";
import {
  DiagnosticPayloadTooLargeError,
  ErrorRegistry,
} from "../src/main/diagnostics/errorRegistry";
import {
  assertDeveloperModeEnabled,
  buildAiDebugReport,
  buildFullPathSummary,
  buildRedactedSummary,
  collectDeveloperSnapshot,
  DeveloperModeRequiredError,
  readLogTail,
  redactText,
  type DeveloperDiagnosticsDeps,
} from "../src/main/diagnostics/developerDiagnostics";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const USER = "alice";
const USER_DATA = "C:\\Users\\alice\\AppData\\Roaming\\ArchiveLens";

function runtimeInfo() {
  return {
    app_version: "0.1.0-test",
    electron: "43.0.0",
    chrome: "130.0.0",
    node: "22.13.0",
    platform: "win32",
    arch: "x64",
    user_data_path: USER_DATA,
    engine_data_path: `${USER_DATA}\\engine`,
    log_path: `${USER_DATA}\\logs`,
    user_name: USER,
    home_dir: "C:\\Users\\alice",
  };
}

function localDataSummary() {
  return {
    user_data_path: USER_DATA,
    engine_data_path: `${USER_DATA}\\engine`,
    log_path: `${USER_DATA}\\logs`,
    total_bytes: 1000,
    database_bytes: 500,
    migration_backup_bytes: 100,
    task_derived_bytes: 200,
    export_bytes: 50,
    temporary_export_bytes: 10,
    log_bytes: 30,
    settings_bytes: 5,
    other_bytes: 5,
    file_count: 10,
    skipped_link_count: 0,
    unreadable_entry_count: 0,
    complete: true,
    tasks: [],
    scanned_at: "2026-07-22T00:00:00.000Z",
  };
}

const desktopBuildInfo: BuildMetadata = {
  version: "0.1.0-test",
  git_commit: "desk123",
  build_time: "2026-07-22T00:00:00Z",
  python_version: "3.11.9",
  node_version: "22.13.0",
  electron_version: "43.0.0",
  protocol_version: 4,
};

function baseDeps(overrides: Partial<DeveloperDiagnosticsDeps> = {}): DeveloperDiagnosticsDeps {
  return {
    runtime: runtimeInfo(),
    sidecar: {
      isReady: true,
      call: async <T,>(method: string): Promise<T> => {
        if (method === "app.info") return { engine_version: "9.9.9", python_executable: `${USER_DATA}\\py\\python.exe`, build_metadata: { git_commit: "eng456" } } as T;
        if (method === "diagnostics.run") return { overall: "PASS", checks: [{ key: "ocr_engine", label: "OCR 引擎", status: "PASS", detail: "就绪", impact: "", remedy: "", extra: { source: "bundled", path: `${USER_DATA}\\models` } }] } as T;
        if (method === "tasks.get") return { status: "completed", workspace_dir: `${USER_DATA}\\engine\\tasks\\t1`, ocr_model_id: "model-x", ocr_model_sha256: "deadbeef", ocr_index_status: "ready", ocr_indexed_pages: 5, ocr_corpus_version: 1, processed_pages: 5, total_pages: 5, occurrence_count: 3, failures: [] } as T;
        if (method === "results.query") return { layout_rebuild: { remaining: 0, completed: 5, total: 5 } } as T;
        if (method === "exports.listJobs") return { items: [{ export_id: "e1", status: "failed", format: "html" }] } as T;
        throw new Error(`unexpected ${method}`);
      },
    },
    collectLocalData: async () => localDataSummary(),
    loadDesktopBuildInfo: () => desktopBuildInfo,
    snapshotForTask: () => null,
    lastKnownError: () => null,
    ...overrides,
  };
}

describe("ErrorRegistry", () => {
  it("记录并返回最近一条已知错误", () => {
    const registry = new ErrorRegistry();
    expect(registry.snapshot()).toBeNull();
    registry.record({ source: "sidecar", operation: "sidecar.exit", code: "ENGINE_CRASHED", message: "崩溃" });
    expect(registry.snapshot()).toMatchObject({ source: "sidecar", code: "ENGINE_CRASHED", message: "崩溃" });
  });

  it("仅在任务匹配时返回该任务的最近错误", () => {
    const registry = new ErrorRegistry();
    registry.record({ source: "engine", operation: "tasks.get", taskId: "t1", code: "TASK_NOT_FOUND", message: "缺失" });
    expect(registry.snapshotForTask("t1")).not.toBeNull();
    expect(registry.snapshotForTask("t2")).toBeNull();
  });

  it("Renderer 上报超限时拒绝并抛 DIAGNOSTIC_PAYLOAD_TOO_LARGE，不截断", () => {
    const registry = new ErrorRegistry();
    expect(() => registry.recordRendererReport({ operation: "x", message: "a".repeat(4001) }))
      .toThrow(DiagnosticPayloadTooLargeError);
    expect(registry.snapshot()).toBeNull();
    const ok = registry.recordRendererReport({ operation: "tasks.list", message: "短消息", task_id: "t1" });
    expect(ok).toMatchObject({ source: "renderer", operation: "tasks.list", task_id: "t1" });
  });
});

describe("开发者模式门禁", () => {
  it("关闭时抛出，开启时通过", () => {
    expect(() => assertDeveloperModeEnabled(false)).toThrow(DeveloperModeRequiredError);
    expect(() => assertDeveloperModeEnabled(true)).not.toThrow();
  });
});

describe("collectDeveloperSnapshot", () => {
  it("组装四组分区并附带当前任务技术状态", async () => {
    const snapshot = await collectDeveloperSnapshot(baseDeps(), { task_id: "t1" });
    expect(snapshot.build_runtime).toMatchObject({ app_version: "0.1.0-test", engine_version: "9.9.9", protocol_version: 4, desktop_commit: "desk123", engine_commit: "eng456", sidecar_ready: true });
    expect(snapshot.checks[0]).toMatchObject({ key: "ocr_engine", status: "PASS", source: "bundled" });
    expect(snapshot.local_data).toMatchObject({ user_data_path: USER_DATA, database_bytes: 500 });
    expect(snapshot.current_task).toMatchObject({ task_id: "t1", ocr_model_id: "model-x", ocr_model_sha256: "deadbeef", status: "completed" });
    expect(snapshot.current_task?.last_failed_export).toMatchObject({ export_id: "e1", status: "failed" });
    expect(snapshot.collection_errors).toEqual([]);
  });

  it("没有当前任务时 current_task 为 null 且不查询任务列表", async () => {
    let listed = false;
    const deps = baseDeps({
      sidecar: {
        isReady: true,
        call: async <T,>(method: string): Promise<T> => {
          if (method === "tasks.list") { listed = true; }
          if (method === "app.info") return { engine_version: "9" } as T;
          if (method === "diagnostics.run") return { checks: [] } as T;
          return {} as T;
        },
      },
    });
    const snapshot = await collectDeveloperSnapshot(deps, {});
    expect(snapshot.current_task).toBeNull();
    expect(listed).toBe(false);
  });

  it("单个分区失败时其余分区仍返回并记入 collection_errors", async () => {
    const deps = baseDeps({
      sidecar: {
        isReady: false,
        call: async <T,>(method: string): Promise<T> => {
          if (method === "app.info") return { engine_version: "9" } as T;
          if (method === "diagnostics.run") throw new Error("诊断服务不可用");
          return {} as T;
        },
      },
    });
    const snapshot = await collectDeveloperSnapshot(deps, {});
    expect(snapshot.build_runtime.engine_version).toBe("9");
    expect(snapshot.checks).toEqual([]);
    expect(snapshot.collection_errors.some((entry) => entry.section === "checks")).toBe(true);
  });
});

describe("剪贴板报告脱敏边界", () => {
  it("脱敏摘要不含用户名、完整路径、文件名、OCR 或日志", async () => {
    const snapshot = await collectDeveloperSnapshot(baseDeps(), { task_id: "t1" });
    const redacted = buildRedactedSummary(snapshot, { code: "TASK_NOT_FOUND", task_id: "t1" });
    expect(redacted).not.toContain(USER);
    expect(redacted).not.toContain("C:\\Users");
    expect(redacted).not.toContain("python.exe");
    expect(redacted).toContain("0.1.0-test");
    expect(redacted).toContain("TASK_NOT_FOUND");
  });

  it("完整路径摘要保留路径与文件名，但不含 OCR 与日志", async () => {
    const snapshot = await collectDeveloperSnapshot(baseDeps(), { task_id: "t1" });
    const full = buildFullPathSummary(snapshot);
    expect(full).toContain(USER_DATA);
    expect(full).toContain("python.exe");
    expect(full).not.toContain("机密OCR正文");
    expect(full).not.toContain("[2026-07-22T00:00:00.000Z]");
  });

  it("AI 报告包含 OCR 上下文、用户名与最近日志", async () => {
    const snapshot = await collectDeveloperSnapshot(baseDeps(), { task_id: "t1" });
    const report = buildAiDebugReport(
      snapshot,
      { status: "included", occurrence: { file_name: "机密.pdf", context_full: "机密OCR正文" }, layout_context: { plain_text: "版面文本" } },
      ["[2026-07-22T00:00:00.000Z] INFO  app 行"],
      [],
    );
    expect(report).toContain("机密OCR正文");
    expect(report).toContain("app 行");
    expect(report).toContain(USER);
    expect(report).toContain("不会自动发送");
  });

  it("无可用选择时 AI 报告标记 ocr_context_status not_available", async () => {
    const snapshot = await collectDeveloperSnapshot(baseDeps(), {});
    const report = buildAiDebugReport(snapshot, { status: "not_available", error: "未提供当前任务或选中结果" }, [], []);
    expect(report).toContain("ocr_context_status: not_available");
  });

  it("redactText 兜底替换 Windows 用户段", () => {
    expect(redactText("C:\\Users\\alice\\logs", "alice", "C:\\Users\\alice")).not.toContain("alice");
  });
});

describe("readLogTail", () => {
  it("读取 .1 与当前文件、按时间排序、最多 300 行", async () => {
    const directory = await mkdtemp(join(tmpdir(), "archivelens-logtail-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "app.log.1"), "[2026-07-22T00:00:01.000Z] INFO  旧app\n", "utf-8");
    await writeFile(join(directory, "app.log"), "[2026-07-22T00:00:03.000Z] INFO  新app\n", "utf-8");
    await writeFile(join(directory, "engine.log"), "[2026-07-22T00:00:02.000Z] engine 中间\n", "utf-8");
    const { lines, errors } = await readLogTail(directory, 300);
    expect(errors).toEqual([]);
    expect(lines).toEqual([
      "[2026-07-22T00:00:01.000Z] INFO  旧app",
      "[2026-07-22T00:00:02.000Z] engine 中间",
      "[2026-07-22T00:00:03.000Z] INFO  新app",
    ]);
  });

  it("最多返回 300 行且取最近的", async () => {
    const directory = await mkdtemp(join(tmpdir(), "archivelens-logtail-"));
    temporaryDirectories.push(directory);
    const many = Array.from({ length: 400 }, (_, index) => `[2026-07-22T00:00:00.000Z] line-${index}`).join("\n");
    await writeFile(join(directory, "app.log"), `${many}\n`, "utf-8");
    const { lines } = await readLogTail(directory, 300);
    expect(lines).toHaveLength(300);
    expect(lines[lines.length - 1]).toBe("[2026-07-22T00:00:00.000Z] line-399");
  });

  it("缺失文件不报错，其余仍复制", async () => {
    const directory = await mkdtemp(join(tmpdir(), "archivelens-logtail-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "app.log"), "[2026-07-22T00:00:00.000Z] 仅有 app\n", "utf-8");
    const { lines, errors } = await readLogTail(directory, 300);
    expect(errors).toEqual([]);
    expect(lines).toEqual(["[2026-07-22T00:00:00.000Z] 仅有 app"]);
  });
});
