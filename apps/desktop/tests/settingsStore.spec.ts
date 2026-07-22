import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEW_DISPLAY_PREFERENCES,
  DEFAULT_REVIEW_HIGHLIGHT_STYLE,
  DEFAULT_SEARCH_SCRIPT_SCOPE,
} from "@shared/index";
import { SettingsStore } from "../src/main/settings/store";

const temporaryDirectories: string[] = [];

async function createStore(onWarning: (message: string) => void = () => undefined) {
  const directory = await mkdtemp(join(tmpdir(), "archivelens-settings-"));
  temporaryDirectories.push(directory);
  const filePath = join(directory, "settings.json");
  return { filePath, store: new SettingsStore(filePath, onWarning) };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("SettingsStore", () => {
  it("首次读取返回默认高亮设置", async () => {
    const { store } = await createStore();
    await expect(store.get("task-1")).resolves.toEqual({
      global: DEFAULT_REVIEW_HIGHLIGHT_STYLE,
      task_override: null,
      effective: DEFAULT_REVIEW_HIGHLIGHT_STYLE,
      global_preferences: DEFAULT_REVIEW_DISPLAY_PREFERENCES,
      task_preferences_override: null,
      effective_preferences: DEFAULT_REVIEW_DISPLAY_PREFERENCES,
      search_script_scope: DEFAULT_SEARCH_SCRIPT_SCOPE,
      page_orientations: {},
      scope: "global",
    });
  });

  it("保存全局设置并跨实例恢复", async () => {
    const { filePath, store } = await createStore();
    const highlight = { color: "#278BC7", opacity: 0.32 };
    await store.update({ scope: "global", task_id: "task-1", highlight });

    const restored = new SettingsStore(filePath);
    await expect(restored.get("task-2")).resolves.toMatchObject({
      global: highlight,
      task_override: null,
      effective: highlight,
      scope: "global",
    });
  });

  it("任务设置覆盖全局设置，并可恢复跟随全局", async () => {
    const { store } = await createStore();
    const global = { color: "#D69E00", opacity: 0.25 };
    const task = { color: "#8C62B8", opacity: 0.41 };
    await store.update({ scope: "global", task_id: "task-1", highlight: global });
    await expect(store.update({ scope: "task", task_id: "task-1", highlight: task })).resolves.toMatchObject({
      global,
      task_override: task,
      effective: task,
      scope: "task",
    });
    await expect(store.update({ scope: "task", task_id: "task-1", highlight: null })).resolves.toMatchObject({
      global,
      task_override: null,
      effective: global,
      scope: "global",
    });
  });

  it("保存全局与任务级出处页及上下文设置", async () => {
    const { store } = await createStore();
    const globalInput = { page_quality: "high" as const, layout_mode: "auto" as const };
    const global = { ...globalInput, page_quality: "maximum" as const };
    const task = { page_quality: "maximum" as const, layout_mode: "vertical" as const };
    await store.update({ scope: "global", preferences: globalInput });
    await expect(store.update({ scope: "task", task_id: "task-1", preferences: task })).resolves.toMatchObject({
      global_preferences: global,
      task_preferences_override: task,
      effective_preferences: task,
      scope: "task",
    });
    await expect(store.update({ scope: "task", task_id: "task-1", preferences: null })).resolves.toMatchObject({
      task_preferences_override: null,
      effective_preferences: global,
    });
  });

  it("版本 1 设置保留高亮并补齐新版默认项", async () => {
    const { filePath } = await createStore();
    await writeFile(filePath, JSON.stringify({
      version: 1,
      appearance: { review_highlight: { color: "#278BC7", opacity: 0.32 } },
      task_overrides: {},
    }), "utf-8");
    const restored = new SettingsStore(filePath);
    await expect(restored.get()).resolves.toMatchObject({
      global: { color: "#278BC7", opacity: 0.32 },
      global_preferences: DEFAULT_REVIEW_DISPLAY_PREFERENCES,
      effective_preferences: DEFAULT_REVIEW_DISPLAY_PREFERENCES,
      search_script_scope: DEFAULT_SEARCH_SCRIPT_SCOPE,
      page_orientations: {},
    });
  });

  it("旧方向与半径设置迁移为自动版面模式", async () => {
    const { filePath } = await createStore();
    await writeFile(filePath, JSON.stringify({
      version: 3,
      appearance: {
        review_preferences: { page_quality: "high", context_direction: "ttb", context_radius: 28 },
      },
      task_overrides: {
        "task-1": {
          review_preferences: { page_quality: "maximum", context_direction: "rtl", context_radius: 12 },
        },
      },
    }), "utf-8");

    const restored = new SettingsStore(filePath);
    await expect(restored.get("task-1")).resolves.toMatchObject({
      global_preferences: { page_quality: "maximum", layout_mode: "auto" },
      task_preferences_override: { page_quality: "maximum", layout_mode: "auto" },
      effective_preferences: { page_quality: "maximum", layout_mode: "auto" },
    });
  });

  it("简繁检索范围默认全部并以版本 4 跨实例保存", async () => {
    const { filePath, store } = await createStore();
    await expect(store.get()).resolves.toMatchObject({
      search_script_scope: "both",
    });
    await expect(store.update({
      scope: "global",
      search_script_scope: "traditional",
    })).resolves.toMatchObject({
      search_script_scope: "traditional",
    });

    const saved = JSON.parse(await readFile(filePath, "utf-8"));
    expect(saved).toMatchObject({
      version: 4,
      appearance: { search_script_scope: "traditional" },
    });
    const restored = new SettingsStore(filePath);
    await expect(restored.get()).resolves.toMatchObject({
      search_script_scope: "traditional",
    });
  });

  it("按任务和源文件保存展示方向并跨实例恢复", async () => {
    const { filePath, store } = await createStore();
    await store.update({ scope: "document", task_id: "task-1", document_id: "doc-a", orientation: "right" });
    await store.update({ scope: "document", task_id: "task-1", document_id: "doc-b", orientation: "down" });
    await store.update({ scope: "document", task_id: "task-2", document_id: "doc-a", orientation: "left" });

    const restored = new SettingsStore(filePath);
    await expect(restored.get("task-1")).resolves.toMatchObject({
      page_orientations: { "doc-a": "right", "doc-b": "down" },
      scope: "global",
    });
    await expect(restored.get("task-2")).resolves.toMatchObject({
      page_orientations: { "doc-a": "left" },
      scope: "global",
    });
  });

  it("删除任务覆盖不会影响全局或其他任务", async () => {
    const { store } = await createStore();
    const first = { color: "#2E9B64", opacity: 0.2 };
    const second = { color: "#E87924", opacity: 0.3 };
    await store.update({ scope: "task", task_id: "task-1", highlight: first });
    await store.update({ scope: "task", task_id: "task-2", highlight: second });
    await store.update({ scope: "document", task_id: "task-1", document_id: "doc-a", orientation: "right" });
    await store.removeTaskOverride("task-1");
    await expect(store.get("task-1")).resolves.toMatchObject({ task_override: null, page_orientations: {}, scope: "global" });
    await expect(store.get("task-2")).resolves.toMatchObject({ task_override: second, effective: second, scope: "task" });
  });

  it("原子保存失败时不会污染内存中的展示方向", async () => {
    const warnings: string[] = [];
    const { filePath, store } = await createStore((message) => warnings.push(message));
    await mkdir(filePath);
    await expect(store.get("task-1")).resolves.toMatchObject({ page_orientations: {} });
    await expect(store.update({ scope: "document", task_id: "task-1", document_id: "doc-a", orientation: "right" })).rejects.toBeTruthy();
    await expect(store.get("task-1")).resolves.toMatchObject({ page_orientations: {} });
    expect(warnings).toHaveLength(1);
  });

  it("损坏的设置文件降级为默认值且不会阻断校对页", async () => {
    const warnings: string[] = [];
    const { filePath, store } = await createStore((message) => warnings.push(message));
    await writeFile(filePath, "{broken", "utf-8");
    await expect(store.get("task-1")).resolves.toMatchObject({ effective: DEFAULT_REVIEW_HIGHLIGHT_STYLE });
    expect(warnings).toHaveLength(1);

    await store.update({ scope: "global", highlight: { color: "#abcdef", opacity: 0.6 } });
    expect(JSON.parse(await readFile(filePath, "utf-8"))).toMatchObject({
      appearance: { review_highlight: { color: "#ABCDEF", opacity: 0.6 } },
    });
  });
});
