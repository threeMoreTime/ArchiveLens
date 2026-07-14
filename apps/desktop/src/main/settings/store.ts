import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  AppSettingsFileSchema,
  DEFAULT_REVIEW_HIGHLIGHT_STYLE,
  ReviewHighlightSettingsGetParamsSchema,
  ReviewHighlightSettingsResultSchema,
  ReviewHighlightSettingsUpdateParamsSchema,
  type AppSettingsFile,
  type ReviewHighlightSettingsResult,
  type ReviewHighlightSettingsUpdateParams,
} from "@shared/index";

function defaultSettings(): AppSettingsFile {
  return AppSettingsFileSchema.parse({});
}

export class SettingsStore {
  private settings: AppSettingsFile | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly onWarning: (message: string) => void = () => undefined,
  ) {}

  async get(taskId?: string): Promise<ReviewHighlightSettingsResult> {
    await this.queue;
    const settings = await this.load();
    return this.resolve(settings, taskId);
  }

  update(params: ReviewHighlightSettingsUpdateParams): Promise<ReviewHighlightSettingsResult> {
    const parsed = ReviewHighlightSettingsUpdateParamsSchema.parse(params);
    return this.enqueue(async () => {
      const settings = await this.load();
      if (parsed.scope === "global") {
        settings.appearance.review_highlight = parsed.highlight;
      } else if (parsed.highlight === null) {
        delete settings.task_overrides[parsed.task_id];
      } else {
        settings.task_overrides[parsed.task_id] = { review_highlight: parsed.highlight };
      }
      await this.save(settings);
      return this.resolve(settings, parsed.task_id);
    });
  }

  removeTaskOverride(taskId: string): Promise<void> {
    return this.enqueue(async () => {
      const settings = await this.load();
      if (!(taskId in settings.task_overrides)) return;
      delete settings.task_overrides[taskId];
      await this.save(settings);
    });
  }

  private async load(): Promise<AppSettingsFile> {
    if (this.settings) return this.settings;
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf-8"));
      const parsed = AppSettingsFileSchema.safeParse(raw);
      if (!parsed.success) {
        this.onWarning(`设置文件格式无效，已使用默认设置：${parsed.error.message}`);
        this.settings = defaultSettings();
      } else {
        this.settings = parsed.data;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") this.onWarning(`读取设置文件失败，已使用默认设置：${(error as Error).message}`);
      this.settings = defaultSettings();
    }
    return this.settings;
  }

  private resolve(settings: AppSettingsFile, taskId?: string): ReviewHighlightSettingsResult {
    const parsedParams = ReviewHighlightSettingsGetParamsSchema.parse(taskId ? { task_id: taskId } : {});
    const taskOverride = parsedParams.task_id
      ? settings.task_overrides[parsedParams.task_id]?.review_highlight ?? null
      : null;
    return ReviewHighlightSettingsResultSchema.parse({
      global: settings.appearance.review_highlight ?? DEFAULT_REVIEW_HIGHLIGHT_STYLE,
      task_override: taskOverride,
      effective: taskOverride ?? settings.appearance.review_highlight ?? DEFAULT_REVIEW_HIGHLIGHT_STYLE,
      scope: taskOverride ? "task" : "global",
    });
  }

  private async save(settings: AppSettingsFile): Promise<void> {
    const parsed = AppSettingsFileSchema.parse(settings);
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
    try {
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM") throw error;
      await writeFile(this.filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
      await unlink(temporaryPath).catch(() => undefined);
    }
    this.settings = parsed;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
