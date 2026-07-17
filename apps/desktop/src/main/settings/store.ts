import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  AppSettingsFileSchema,
  DEFAULT_REVIEW_DISPLAY_PREFERENCES,
  DEFAULT_REVIEW_HIGHLIGHT_STYLE,
  DEFAULT_SEARCH_SCRIPT_SCOPE,
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
      const settings = AppSettingsFileSchema.parse(await this.load());
      if (parsed.scope === "document") {
        const override = settings.task_overrides[parsed.task_id];
        settings.task_overrides[parsed.task_id] = {
          ...override,
          page_orientations: {
            ...override?.page_orientations,
            [parsed.document_id]: parsed.orientation,
          },
        };
      } else if ("search_script_scope" in parsed) {
        settings.appearance.search_script_scope = parsed.search_script_scope;
      } else if ("highlight" in parsed) {
        if (parsed.scope === "global") {
          settings.appearance.review_highlight = parsed.highlight;
        } else if (parsed.highlight === null) {
          const override = settings.task_overrides[parsed.task_id];
          if (override) {
            delete override.review_highlight;
            this.removeEmptyOverride(settings, parsed.task_id);
          }
        } else {
          settings.task_overrides[parsed.task_id] = {
            ...settings.task_overrides[parsed.task_id],
            review_highlight: parsed.highlight,
          };
        }
      } else if (parsed.scope === "global") {
        settings.appearance.review_preferences = parsed.preferences;
      } else if (parsed.preferences === null) {
        const override = settings.task_overrides[parsed.task_id];
        if (override) {
          delete override.review_preferences;
          this.removeEmptyOverride(settings, parsed.task_id);
        }
      } else {
        settings.task_overrides[parsed.task_id] = {
          ...settings.task_overrides[parsed.task_id],
          review_preferences: parsed.preferences,
        };
      }
      await this.save(settings);
      return this.resolve(settings, "task_id" in parsed ? parsed.task_id : undefined);
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
    const override = parsedParams.task_id ? settings.task_overrides[parsedParams.task_id] : undefined;
    const taskOverride = override?.review_highlight ?? null;
    const taskPreferencesOverride = override?.review_preferences ?? null;
    return ReviewHighlightSettingsResultSchema.parse({
      global: settings.appearance.review_highlight ?? DEFAULT_REVIEW_HIGHLIGHT_STYLE,
      task_override: taskOverride,
      effective: taskOverride ?? settings.appearance.review_highlight ?? DEFAULT_REVIEW_HIGHLIGHT_STYLE,
      global_preferences: settings.appearance.review_preferences ?? DEFAULT_REVIEW_DISPLAY_PREFERENCES,
      task_preferences_override: taskPreferencesOverride,
      effective_preferences: taskPreferencesOverride
        ?? settings.appearance.review_preferences
        ?? DEFAULT_REVIEW_DISPLAY_PREFERENCES,
      search_script_scope: settings.appearance.search_script_scope
        ?? DEFAULT_SEARCH_SCRIPT_SCOPE,
      page_orientations: override?.page_orientations ?? {},
      scope: taskOverride || taskPreferencesOverride ? "task" : "global",
    });
  }

  private removeEmptyOverride(settings: AppSettingsFile, taskId: string): void {
    const override = settings.task_overrides[taskId];
    if (override
      && !override.review_highlight
      && !override.review_preferences
      && !Object.keys(override.page_orientations ?? {}).length) {
      delete settings.task_overrides[taskId];
    }
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
