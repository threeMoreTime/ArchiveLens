import { useEffect, useMemo, useState } from "react";
import { Button, Text } from "@fluentui/react-components";
import {
  DEFAULT_REVIEW_HIGHLIGHT_STYLE,
  type ReviewHighlightSettingsResult,
  type ReviewHighlightStyle,
} from "@shared/index";

const HIGHLIGHT_PRESETS = [
  { label: "淡红", color: "#C44516" },
  { label: "淡黄", color: "#D69E00" },
  { label: "淡橙", color: "#E87924" },
  { label: "淡绿", color: "#2E9B64" },
  { label: "淡蓝", color: "#278BC7" },
  { label: "淡紫", color: "#8C62B8" },
] as const;

type SettingsScope = "task" | "global";
type SaveState = "idle" | "saving" | "saved" | "error";

export function highlightBackground(style: ReviewHighlightStyle): string {
  const red = Number.parseInt(style.color.slice(1, 3), 16);
  const green = Number.parseInt(style.color.slice(3, 5), 16);
  const blue = Number.parseInt(style.color.slice(5, 7), 16);
  return `rgba(${red}, ${green}, ${blue}, ${style.opacity})`;
}

export interface HighlightTaskOption {
  taskId: string;
  label: string;
}

interface ReviewHighlightSettingsProps {
  tasks: HighlightTaskOption[];
  initialTaskId?: string | null;
}

export function ReviewHighlightSettings({ tasks, initialTaskId }: ReviewHighlightSettingsProps) {
  const [scope, setScope] = useState<SettingsScope>("global");
  const [selectedTaskId, setSelectedTaskId] = useState(() => initialTaskId ?? tasks[0]?.taskId ?? "");
  const [settings, setSettings] = useState<ReviewHighlightSettingsResult | null>(null);
  const [globalDraft, setGlobalDraft] = useState<ReviewHighlightStyle>(DEFAULT_REVIEW_HIGHLIGHT_STYLE);
  const [taskDraft, setTaskDraft] = useState<ReviewHighlightStyle>(DEFAULT_REVIEW_HIGHLIGHT_STYLE);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    if (selectedTaskId && tasks.some((task) => task.taskId === selectedTaskId)) return;
    setSelectedTaskId(initialTaskId && tasks.some((task) => task.taskId === initialTaskId)
      ? initialTaskId
      : tasks[0]?.taskId ?? "");
  }, [initialTaskId, selectedTaskId, tasks]);

  useEffect(() => {
    let active = true;
    setSettings(null);
    setSaveState("idle");
    setError("");
    window.archiveLens.settings.get(selectedTaskId || undefined).then((result: ReviewHighlightSettingsResult) => {
      if (!active) return;
      setSettings(result);
      setGlobalDraft(result.global);
      setTaskDraft(result.task_override ?? result.global);
    }).catch((loadError: unknown) => {
      if (!active) return;
      setError(`读取高亮设置失败：${loadError instanceof Error ? loadError.message : "请重试"}`);
    });
    return () => { active = false; };
  }, [selectedTaskId]);

  const activeStyle = scope === "global" ? globalDraft : taskDraft;
  const followsGlobal = settings?.task_override == null;
  const previewBackground = useMemo(() => highlightBackground(activeStyle), [activeStyle]);

  const changeDraft = (next: ReviewHighlightStyle) => {
    setSaveState("idle");
    setError("");
    if (scope === "global") setGlobalDraft(next);
    else setTaskDraft(next);
  };

  const persist = async (next: ReviewHighlightStyle) => {
    setSaveState("saving");
    setError("");
    try {
      const result: ReviewHighlightSettingsResult = await window.archiveLens.settings.update(
        scope === "global"
          ? { scope: "global", task_id: selectedTaskId || undefined, highlight: next }
          : { scope: "task", task_id: selectedTaskId, highlight: next },
      );
      setSettings(result);
      setGlobalDraft(result.global);
      setTaskDraft(result.task_override ?? result.global);
      setSaveState("saved");
    } catch (saveError) {
      setSaveState("error");
      setError(`保存失败：${saveError instanceof Error ? saveError.message : "请重试"}`);
    }
  };

  const applyStyle = (next: ReviewHighlightStyle) => {
    changeDraft(next);
    void persist(next);
  };

  const restore = async () => {
    if (scope === "global") {
      applyStyle(DEFAULT_REVIEW_HIGHLIGHT_STYLE);
      return;
    }
    setSaveState("saving");
    setError("");
    try {
      const result: ReviewHighlightSettingsResult = await window.archiveLens.settings.update({
        scope: "task",
        task_id: selectedTaskId,
        highlight: null,
      });
      setSettings(result);
      setGlobalDraft(result.global);
      setTaskDraft(result.global);
      setSaveState("saved");
    } catch (restoreError) {
      setSaveState("error");
      setError(`恢复失败：${restoreError instanceof Error ? restoreError.message : "请重试"}`);
    }
  };

  return (
    <section className="al-highlight-settings-panel" aria-label="命中关键字高亮设置">
          <div className="al-highlight-settings-heading">
            <div><Text weight="semibold">命中关键字高亮</Text><Text className="al-muted">仅影响校对工作台显示</Text></div>
          </div>

          <div className="al-highlight-settings-tabs" role="tablist" aria-label="配置范围">
            <button type="button" role="tab" aria-selected={scope === "global"} onClick={() => setScope("global")}>全局默认</button>
            <button type="button" role="tab" aria-selected={scope === "task"} onClick={() => setScope("task")}>指定任务</button>
          </div>

          {scope === "task" ? (
            <>
              <label className="al-highlight-task-select">
                <span>选择任务</span>
                <select value={selectedTaskId} onChange={(event) => setSelectedTaskId(event.target.value)} disabled={tasks.length === 0}>
                  {tasks.length === 0 && <option value="">暂无可配置任务</option>}
                  {tasks.map((task) => <option value={task.taskId} key={task.taskId}>{task.label}</option>)}
                </select>
              </label>
              <Text className="al-highlight-scope-note">
                {tasks.length === 0 ? "创建任务后可为单个任务设置高亮颜色。" : followsGlobal ? "该任务正在跟随全局设置；修改任意选项会创建单独设置。" : "该任务使用单独设置，不受全局颜色变化影响。"}
              </Text>
            </>
          ) : <Text className="al-highlight-scope-note">修改后应用于所有未设置单独颜色的任务。</Text>}

          <fieldset disabled={!settings || saveState === "saving" || (scope === "task" && !selectedTaskId)}>
            <legend>预设颜色</legend>
            <div className="al-highlight-presets">
              {HIGHLIGHT_PRESETS.map((preset) => (
                <button
                  type="button"
                  key={preset.color}
                  aria-label={preset.label}
                  aria-pressed={activeStyle.color === preset.color}
                  title={preset.label}
                  style={{ backgroundColor: preset.color }}
                  onClick={() => applyStyle({ ...activeStyle, color: preset.color })}
                />
              ))}
            </div>

            <label className="al-highlight-color-row">
              <span>自定义颜色</span>
              <input
                type="color"
                aria-label="自定义高亮颜色"
                value={activeStyle.color}
                onChange={(event) => applyStyle({ ...activeStyle, color: event.target.value.toUpperCase() })}
              />
              <output>{activeStyle.color}</output>
            </label>

            <label className="al-highlight-opacity-row">
              <span>透明度</span>
              <input
                type="range"
                aria-label="高亮透明度"
                min="10"
                max="60"
                step="1"
                value={Math.round(activeStyle.opacity * 100)}
                onChange={(event) => changeDraft({ ...activeStyle, opacity: Number(event.target.value) / 100 })}
                onPointerUp={(event) => void persist({ ...activeStyle, opacity: Number(event.currentTarget.value) / 100 })}
                onKeyUp={(event) => void persist({ ...activeStyle, opacity: Number(event.currentTarget.value) / 100 })}
                onBlur={(event) => saveState === "idle" && void persist({ ...activeStyle, opacity: Number(event.currentTarget.value) / 100 })}
              />
              <output>{Math.round(activeStyle.opacity * 100)}%</output>
            </label>
          </fieldset>

          <div className="al-highlight-preview"><span style={{ background: previewBackground }}>命中关键字</span></div>
          <div className="al-highlight-settings-footer">
            <Button disabled={!settings || saveState === "saving" || (scope === "task" && !selectedTaskId)} onClick={() => void restore()}>
              {scope === "task" ? "恢复跟随全局" : "恢复产品默认"}
            </Button>
            <Text role="status" className={saveState === "error" ? "al-highlight-save-error" : "al-muted"}>
              {error || (saveState === "saving" ? "正在保存…" : saveState === "saved" ? "已保存" : "修改后自动保存")}
            </Text>
          </div>
    </section>
  );
}
