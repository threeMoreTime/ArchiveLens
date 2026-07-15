import { useEffect, useMemo, useState } from "react";
import { Button, Text } from "@fluentui/react-components";
import {
  DEFAULT_REVIEW_DISPLAY_PREFERENCES,
  DEFAULT_REVIEW_HIGHLIGHT_STYLE,
  type ContextReadingDirection,
  type ReviewDisplayPreferences,
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

const QUALITY_OPTIONS = [
  { value: "standard", label: "标准", dpi: 144, detail: "磁盘占用较低" },
  { value: "clear", label: "清晰", dpi: 200, detail: "适合日常校对" },
  { value: "high", label: "高清", dpi: 240, detail: "适合小字号档案" },
  { value: "maximum", label: "最清晰", dpi: 300, detail: "生成更慢且占用更多空间" },
] as const;

const DIRECTION_OPTIONS: Array<{ value: ContextReadingDirection; label: string; detail: string }> = [
  { value: "ltr", label: "从左到右", detail: "左侧 → 关键词 → 右侧" },
  { value: "rtl", label: "从右到左", detail: "右侧 → 关键词 → 左侧" },
  { value: "ttb", label: "从上到下", detail: "上方 → 关键词 → 下方；跨列时从右向左" },
  { value: "btt", label: "从下到上", detail: "下方 → 关键词 → 上方；跨列时从左向右" },
];

function ArchiveQualitySample({ quality, highlight }: { quality: string; highlight: string }) {
  return (
    <div className={`al-archive-quality-sample quality-${quality}`} aria-hidden="true">
      <div className="al-archive-sample-paper">
        <span>本馆清册　第廿七号</span>
        <span>民国十七年三月收存</span>
        <span>所载<span className="al-archive-keyword" style={{ background: highlight }}>卷宗</span>核验归档</span>
        <i>档</i>
      </div>
      <div className="al-quality-magnifier">
        <small>局部 2×</small>
        <span className="al-quality-magnifier-text" style={{ background: highlight }}>卷宗</span>
      </div>
    </div>
  );
}

function ArchiveDirectionSample({ direction, highlight, contextRadius }: { direction: ContextReadingDirection; highlight: string; contextRadius: number }) {
  const horizontal = direction === "ltr" || direction === "rtl";
  const forward = direction === "ltr" || direction === "ttb";
  const coverage = `${Math.min(92, 28 + contextRadius * 1.25)}%`;
  const rangeLabels = direction === "ltr"
    ? ["左侧", "右侧"]
    : direction === "rtl"
      ? ["右侧", "左侧"]
      : direction === "ttb"
        ? ["上方", "下方"]
        : ["下方", "上方"];

  if (horizontal) {
    const orders = forward ? ["①", "②", "③"] : ["③", "②", "①"];
    return (
      <div className={`al-archive-direction-sample direction-${direction}`} aria-hidden="true">
        <div className="al-context-range-band horizontal" style={{ width: coverage }} />
        <div className="al-horizontal-archive-line">
          <span className="al-horizontal-segment"><b>{orders[0]}</b><span>本馆清册</span></span>
          <span className="al-horizontal-segment"><b>{orders[1]}</b><span className="al-archive-keyword" style={{ background: highlight }}>卷宗</span></span>
          <span className="al-horizontal-segment"><b>{orders[2]}</b><span>依次编号</span></span>
        </div>
        <div className="al-context-range-caption"><span>{rangeLabels[0]} {contextRadius} 字</span><b>关键词</b><span>{rangeLabels[1]} {contextRadius} 字</span></div>
      </div>
    );
  }

  return (
    <div className={`al-archive-direction-sample direction-${direction}`} aria-hidden="true">
      <div className="al-vertical-archive-column continuation">
        <span className="al-direction-index">{forward ? "④" : "⑤"}</span>
        <span>{forward ? "清册" : "编号"}</span>
        <span>依次</span>
        <span>{forward ? "编号" : "清册"}</span>
        <span className="al-direction-index">{forward ? "⑤" : "④"}</span>
        <i>{forward ? "↓" : "↑"}</i>
      </div>
      <div className="al-vertical-column-connector">{forward ? "↖" : "↘"}</div>
      <div className="al-vertical-archive-column primary">
        <span className="al-direction-index">{forward ? "①" : "③"}</span>
        <span>{forward ? "本馆" : "归档"}</span>
        <span className="al-archive-keyword" style={{ background: highlight }}>卷宗</span>
        <span>{forward ? "归档" : "本馆"}</span>
        <span className="al-direction-index">{forward ? "③" : "①"}</span>
        <i>{forward ? "↓" : "↑"}</i>
      </div>
      <div className="al-context-range-band vertical" style={{ height: coverage }} />
      <div className="al-context-range-caption"><span>{rangeLabels[0]} {contextRadius} 字</span><b>关键词</b><span>{rangeLabels[1]} {contextRadius} 字</span></div>
    </div>
  );
}

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
  const [globalPreferences, setGlobalPreferences] = useState<ReviewDisplayPreferences>(DEFAULT_REVIEW_DISPLAY_PREFERENCES);
  const [taskPreferences, setTaskPreferences] = useState<ReviewDisplayPreferences>(DEFAULT_REVIEW_DISPLAY_PREFERENCES);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState("");
  const [qualityExpanded, setQualityExpanded] = useState(true);
  const [directionExpanded, setDirectionExpanded] = useState(true);

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
      setGlobalPreferences(result.global_preferences);
      setTaskPreferences(result.task_preferences_override ?? result.global_preferences);
    }).catch((loadError: unknown) => {
      if (!active) return;
      setError(`读取校对设置失败：${loadError instanceof Error ? loadError.message : "请重试"}`);
    });
    return () => { active = false; };
  }, [selectedTaskId]);

  const activeStyle = scope === "global" ? globalDraft : taskDraft;
  const activePreferences = scope === "global" ? globalPreferences : taskPreferences;
  const followsGlobal = settings?.task_override == null && settings?.task_preferences_override == null;
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
      setGlobalPreferences(result.global_preferences);
      setTaskPreferences(result.task_preferences_override ?? result.global_preferences);
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
      setGlobalPreferences(result.global_preferences);
      setTaskPreferences(result.task_preferences_override ?? result.global_preferences);
      setSaveState("saved");
    } catch (restoreError) {
      setSaveState("error");
      setError(`恢复失败：${restoreError instanceof Error ? restoreError.message : "请重试"}`);
    }
  };

  const persistPreferences = async (next: ReviewDisplayPreferences) => {
    setSaveState("saving");
    setError("");
    if (scope === "global") setGlobalPreferences(next);
    else setTaskPreferences(next);
    try {
      const result: ReviewHighlightSettingsResult = await window.archiveLens.settings.update(
        scope === "global"
          ? { scope: "global", task_id: selectedTaskId || undefined, preferences: next }
          : { scope: "task", task_id: selectedTaskId, preferences: next },
      );
      setSettings(result);
      setGlobalPreferences(result.global_preferences);
      setTaskPreferences(result.task_preferences_override ?? result.global_preferences);
      setSaveState("saved");
    } catch (saveError) {
      setSaveState("error");
      setError(`保存失败：${saveError instanceof Error ? saveError.message : "请重试"}`);
    }
  };

  const restorePreferences = async () => {
    if (scope === "global") {
      await persistPreferences(DEFAULT_REVIEW_DISPLAY_PREFERENCES);
      return;
    }
    setSaveState("saving");
    setError("");
    try {
      const result: ReviewHighlightSettingsResult = await window.archiveLens.settings.update({
        scope: "task",
        task_id: selectedTaskId,
        preferences: null,
      });
      setSettings(result);
      setGlobalPreferences(result.global_preferences);
      setTaskPreferences(result.global_preferences);
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
          <div className="al-review-preferences-heading">
            <div><Text weight="semibold">出处页与上下文</Text><Text className="al-muted">创建扫描任务时固化；已完成任务需要使用原来源重新扫描后生效。</Text></div>
          </div>

          <fieldset className="al-review-preferences" disabled={!settings || saveState === "saving" || (scope === "task" && !selectedTaskId)}>
            <legend>出处页与上下文配置</legend>
            <section className="al-review-preference-group">
              <button
                type="button"
                className="al-review-preference-toggle"
                aria-expanded={qualityExpanded}
                aria-controls="review-quality-options"
                onClick={() => setQualityExpanded((expanded) => !expanded)}
              >
                <span><strong>命中页清晰度</strong><small>{QUALITY_OPTIONS.find((option) => option.value === activePreferences.page_quality)?.label ?? "未选择"}</small></span>
                <b aria-hidden="true">{qualityExpanded ? "收起 −" : "展开 +"}</b>
              </button>
              {qualityExpanded && (
                <div id="review-quality-options" className="al-review-preference-content">
                  <Text className="al-review-simulation-note">以下为清晰度示意，实际效果取决于原始文件质量。</Text>
                  <div className="al-review-option-grid" role="radiogroup" aria-label="命中页清晰度">
                    {QUALITY_OPTIONS.map((option) => (
                      <label
                        key={option.value}
                        className={activePreferences.page_quality === option.value ? "selected" : ""}
                        aria-label={`${option.label}，${option.dpi} DPI，${option.detail}`}
                      >
                        <input
                          type="radio"
                          name={`review-quality-${scope}`}
                          value={option.value}
                          checked={activePreferences.page_quality === option.value}
                          onChange={() => void persistPreferences({ ...activePreferences, page_quality: option.value })}
                        />
                        <div className="al-review-option-content">
                          <div className="al-review-option-title"><strong>{option.label}</strong><span>{option.dpi} DPI · {option.detail}</span></div>
                          <ArchiveQualitySample quality={option.value} highlight={previewBackground} />
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </section>

            <section className="al-review-preference-group">
              <button
                type="button"
                className="al-review-preference-toggle"
                aria-expanded={directionExpanded}
                aria-controls="review-direction-options"
                onClick={() => setDirectionExpanded((expanded) => !expanded)}
              >
                <span><strong>上下文阅读方向</strong><small>{DIRECTION_OPTIONS.find((option) => option.value === activePreferences.context_direction)?.label ?? "未选择"}</small></span>
                <b aria-hidden="true">{directionExpanded ? "收起 −" : "展开 +"}</b>
              </button>
              {directionExpanded && (
                <div id="review-direction-options" className="al-review-preference-content">
                  <div className="al-review-option-grid" role="radiogroup" aria-label="上下文阅读方向">
                    {DIRECTION_OPTIONS.map((option) => (
                      <label
                        key={option.value}
                        className={activePreferences.context_direction === option.value ? "selected" : ""}
                        aria-label={`${option.label}：${option.detail}`}
                      >
                        <input
                          type="radio"
                          name={`context-direction-${scope}`}
                          value={option.value}
                          checked={activePreferences.context_direction === option.value}
                          onChange={() => void persistPreferences({ ...activePreferences, context_direction: option.value })}
                        />
                        <div className="al-review-option-content">
                          <div className="al-review-option-title"><strong>{option.label}</strong></div>
                          <ArchiveDirectionSample direction={option.value} highlight={previewBackground} contextRadius={activePreferences.context_radius} />
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </section>

            <label className="al-context-radius-row">
              <span>关键词前后每侧字数</span>
              <input
                type="range"
                min="1"
                max="50"
                step="1"
                value={activePreferences.context_radius}
                onChange={(event) => {
                  const next = { ...activePreferences, context_radius: Number(event.target.value) };
                  setSaveState("idle");
                  if (scope === "global") setGlobalPreferences(next);
                  else setTaskPreferences(next);
                }}
                onPointerUp={(event) => void persistPreferences({ ...activePreferences, context_radius: Number(event.currentTarget.value) })}
                onKeyUp={(event) => void persistPreferences({ ...activePreferences, context_radius: Number(event.currentTarget.value) })}
                onBlur={(event) => saveState === "idle" && void persistPreferences({ ...activePreferences, context_radius: Number(event.currentTarget.value) })}
              />
              <output>{activePreferences.context_radius} 字/侧</output>
            </label>
            <Text className="al-muted">汉字、字母、数字和标点均计数；空格、制表符和换行不计数。跨行或跨列时继续按所选阅读方向取字。</Text>
            <Button onClick={() => void restorePreferences()}>
              {scope === "task" ? "出处页与上下文恢复跟随全局" : "出处页与上下文恢复产品默认"}
            </Button>
          </fieldset>
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
