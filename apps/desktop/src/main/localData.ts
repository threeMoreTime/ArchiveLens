import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface LocalDataTaskUsage {
  task_id: string;
  derived_bytes: number;
  export_bytes: number;
  total_bytes: number;
}

export interface LocalDataSummary {
  user_data_path: string;
  engine_data_path: string;
  log_path: string;
  total_bytes: number;
  database_bytes: number;
  task_derived_bytes: number;
  export_bytes: number;
  temporary_export_bytes: number;
  log_bytes: number;
  settings_bytes: number;
  other_bytes: number;
  file_count: number;
  skipped_link_count: number;
  unreadable_entry_count: number;
  complete: boolean;
  tasks: LocalDataTaskUsage[];
  scanned_at: string;
}

interface MutableTaskUsage {
  task_id: string;
  derived_bytes: number;
  export_bytes: number;
}

const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function pathSegments(root: string, path: string): string[] {
  return relative(root, path).split(/[\\/]+/u).filter(Boolean);
}

function isDatabaseFile(name: string): boolean {
  return name === "archivelens.db" || name.startsWith("archivelens.db-");
}

/**
 * 统计 Main 所拥有的 userData，不跟随符号链接或 Windows junction。
 *
 * 返回的是当前进程可读取文件的精确字节数；遇到拒绝访问或链接时将 complete 置为
 * false，界面不得把结果描述为完整占用。原始来源档案位于 userData 外，不在统计范围。
 */
export async function collectLocalDataSummary(userDataPath: string): Promise<LocalDataSummary> {
  const root = resolve(userDataPath);
  const engineRoot = join(root, "engine");
  const logRoot = join(root, "logs");
  const tasks = new Map<string, MutableTaskUsage>();
  const summary: LocalDataSummary = {
    user_data_path: root,
    engine_data_path: engineRoot,
    log_path: logRoot,
    total_bytes: 0,
    database_bytes: 0,
    task_derived_bytes: 0,
    export_bytes: 0,
    temporary_export_bytes: 0,
    log_bytes: 0,
    settings_bytes: 0,
    other_bytes: 0,
    file_count: 0,
    skipped_link_count: 0,
    unreadable_entry_count: 0,
    complete: true,
    tasks: [],
    scanned_at: new Date().toISOString(),
  };

  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && directory === root) break;
      summary.unreadable_entry_count += 1;
      summary.complete = false;
      continue;
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      let stats;
      try {
        stats = await lstat(absolute);
      } catch {
        summary.unreadable_entry_count += 1;
        summary.complete = false;
        continue;
      }
      if (entry.isSymbolicLink() || stats.isSymbolicLink()) {
        summary.skipped_link_count += 1;
        summary.complete = false;
        continue;
      }
      if (stats.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      if (!stats.isFile()) continue;

      const size = stats.size;
      const segments = pathSegments(root, absolute);
      summary.total_bytes += size;
      summary.file_count += 1;
      if (segments[0] === "logs") {
        summary.log_bytes += size;
      } else if (segments.length === 1 && segments[0] === "settings.json") {
        summary.settings_bytes += size;
      } else if (segments[0] === "engine" && segments[1] === ".export-jobs") {
        summary.temporary_export_bytes += size;
      } else if (segments[0] === "engine" && segments.length === 2 && isDatabaseFile(segments[1]!)) {
        summary.database_bytes += size;
      } else if (segments[0] === "engine" && segments[1] === "tasks" && segments[2]) {
        const taskId = segments[2];
        const usage = tasks.get(taskId) ?? { task_id: taskId, derived_bytes: 0, export_bytes: 0 };
        if (segments[3] === "exports") {
          usage.export_bytes += size;
          summary.export_bytes += size;
        } else {
          usage.derived_bytes += size;
          summary.task_derived_bytes += size;
        }
        tasks.set(taskId, usage);
      } else {
        summary.other_bytes += size;
      }
    }
  }

  summary.tasks = [...tasks.values()]
    .map((task) => ({ ...task, total_bytes: task.derived_bytes + task.export_bytes }))
    .sort((left, right) => right.total_bytes - left.total_bytes || left.task_id.localeCompare(right.task_id));
  return summary;
}

function assertContained(root: string, candidate: string): void {
  const rel = relative(resolve(root), resolve(candidate));
  if (!rel || rel === ".") return;
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("路径越出 ArchiveLens 本地数据目录");
  }
}

async function assertPathChainHasNoLinks(root: string, candidate: string): Promise<void> {
  const resolvedRoot = resolve(root);
  const rel = relative(resolvedRoot, resolve(candidate));
  assertContained(resolvedRoot, candidate);
  let current = resolvedRoot;
  for (const segment of rel.split(/[\\/]+/u).filter(Boolean)) {
    current = join(current, segment);
    const stats = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new Error("任务目录尚不存在或已清理");
      throw error;
    });
    if (stats.isSymbolicLink()) throw new Error("任务目录链包含链接，已拒绝打开");
  }
}

/** 仅从受信 userData 与闭合 task_id 推导任务目录，绝不接受 renderer 路径。 */
export async function resolveTaskDataDirectory(userDataPath: string, taskId: string): Promise<string> {
  if (!TASK_ID_PATTERN.test(taskId)) throw new Error("任务标识无效");
  const tasksRoot = join(resolve(userDataPath), "engine", "tasks");
  const candidate = join(tasksRoot, taskId);
  await assertPathChainHasNoLinks(resolve(userDataPath), candidate);
  const stats = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error("任务目录尚不存在或已清理");
    throw error;
  });
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error("任务目录不可信，已拒绝打开");
  return candidate;
}

/** 导出目录同样只从任务标识推导，并拒绝链接或尚不存在的目录。 */
export async function resolveTaskExportDirectory(userDataPath: string, taskId: string): Promise<string> {
  const taskDirectory = await resolveTaskDataDirectory(userDataPath, taskId);
  const candidate = join(taskDirectory, "exports");
  await assertPathChainHasNoLinks(resolve(userDataPath), candidate);
  const stats = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error("该任务尚无可打开的导出目录");
    throw error;
  });
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error("导出目录不可信，已拒绝打开");
  return candidate;
}
