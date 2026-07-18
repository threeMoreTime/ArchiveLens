import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectLocalDataSummary,
  resolveTaskDataDirectory,
  resolveTaskExportDirectory,
} from "../src/main/localData";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "archivelens-local-data-test-"));
  roots.push(root);
  return root;
}

async function sizedFile(filePath: string, size: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.alloc(size, 0x61));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("本地数据统计与受控目录", () => {
  it("按数据库、任务、导出、临时、日志和设置分类且不重复累计", async () => {
    const root = await makeRoot();
    await sizedFile(path.join(root, "engine", "archivelens.db"), 5);
    await sizedFile(path.join(root, "engine", "archivelens.db-wal"), 7);
    await sizedFile(path.join(root, "engine", "backups", "archivelens-v9.sqlite3"), 31);
    await sizedFile(path.join(root, "engine", "backups", "archivelens-v9.json"), 37);
    await sizedFile(path.join(root, "engine", "tasks", "task-1", "scan", "page.png"), 11);
    await sizedFile(path.join(root, "engine", "tasks", "task-1", "exports", "report.html"), 13);
    await sizedFile(path.join(root, "engine", ".export-jobs", "export-1", "partial"), 17);
    await sizedFile(path.join(root, "logs", "app.log"), 19);
    await sizedFile(path.join(root, "settings.json"), 23);
    await sizedFile(path.join(root, "engine", "other.bin"), 29);

    const summary = await collectLocalDataSummary(root);
    expect(summary.complete).toBe(true);
    expect(summary.total_bytes).toBe(192);
    expect(summary.database_bytes).toBe(12);
    expect(summary.migration_backup_bytes).toBe(68);
    expect(summary.task_derived_bytes).toBe(11);
    expect(summary.export_bytes).toBe(13);
    expect(summary.temporary_export_bytes).toBe(17);
    expect(summary.log_bytes).toBe(19);
    expect(summary.settings_bytes).toBe(23);
    expect(summary.other_bytes).toBe(29);
    expect(summary.tasks).toEqual([{
      task_id: "task-1",
      derived_bytes: 11,
      export_bytes: 13,
      total_bytes: 24,
    }]);
  });

  it("不跟随 userData 内链接，并把统计标记为不完整", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    await sizedFile(path.join(outside, "private.bin"), 101);
    const link = path.join(root, "engine", "tasks", "linked-task");
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");

    const summary = await collectLocalDataSummary(root);
    expect(summary.total_bytes).toBe(0);
    expect(summary.skipped_link_count).toBe(1);
    expect(summary.complete).toBe(false);
  });

  it("任务与导出入口只接受受信 task_id 和真实目录", async () => {
    const root = await makeRoot();
    const taskDirectory = path.join(root, "engine", "tasks", "task-safe");
    const exportDirectory = path.join(taskDirectory, "exports");
    await mkdir(exportDirectory, { recursive: true });

    await expect(resolveTaskDataDirectory(root, "task-safe")).resolves.toBe(taskDirectory);
    await expect(resolveTaskExportDirectory(root, "task-safe")).resolves.toBe(exportDirectory);
    await expect(resolveTaskDataDirectory(root, "..\\outside")).rejects.toThrow("任务标识无效");
    await expect(resolveTaskDataDirectory(root, "missing-task")).rejects.toThrow("尚不存在");
  });

  it("任务目录任一父级是 junction 时拒绝越出 userData", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    await mkdir(path.join(outside, "task-through-link"), { recursive: true });
    await mkdir(path.join(root, "engine"), { recursive: true });
    await symlink(outside, path.join(root, "engine", "tasks"), process.platform === "win32" ? "junction" : "dir");

    await expect(resolveTaskDataDirectory(root, "task-through-link")).rejects.toThrow("包含链接");
  });
});
