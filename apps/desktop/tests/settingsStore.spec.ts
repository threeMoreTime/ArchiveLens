import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_REVIEW_HIGHLIGHT_STYLE } from "@shared/index";
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

  it("删除任务覆盖不会影响全局或其他任务", async () => {
    const { store } = await createStore();
    const first = { color: "#2E9B64", opacity: 0.2 };
    const second = { color: "#E87924", opacity: 0.3 };
    await store.update({ scope: "task", task_id: "task-1", highlight: first });
    await store.update({ scope: "task", task_id: "task-2", highlight: second });
    await store.removeTaskOverride("task-1");
    await expect(store.get("task-1")).resolves.toMatchObject({ task_override: null, scope: "global" });
    await expect(store.get("task-2")).resolves.toMatchObject({ task_override: second, effective: second, scope: "task" });
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
