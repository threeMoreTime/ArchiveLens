import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Button, Text } from "@fluentui/react-components";
import { InlineFeedback } from "./feedback";
import {
  DEFAULT_REVIEW_SHORTCUTS,
  REVIEW_SHORTCUT_OPTIONS,
  normalizeReviewShortcutKey,
  readReviewShortcutBindings,
  reviewShortcutKeyLabel,
  storeReviewShortcutBindings,
  type ConfigurableReviewShortcutAction,
  type ReviewShortcutBindings,
} from "../utils/reviewShortcuts";

export function ReviewShortcutSettings() {
  const [bindings, setBindings] = useState<ReviewShortcutBindings>(readReviewShortcutBindings);
  const [capturing, setCapturing] = useState<ConfigurableReviewShortcutAction | null>(null);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");

  const captureKey = (
    action: ConfigurableReviewShortcutAction,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    if (capturing !== action) return;
    if (event.key === "Tab") {
      setCapturing(null);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setCapturing(null);
      setError("");
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.key === "?") {
      setError("请使用单个字母、数字或 Space。问号、组合键和方向键保留给固定操作。");
      return;
    }
    const key = normalizeReviewShortcutKey(event.key);
    if (!key) {
      setError("该按键不能用于校对操作，请使用单个字母、数字或 Space。");
      return;
    }
    const conflict = REVIEW_SHORTCUT_OPTIONS.find((option) => (
      option.action !== action && bindings[option.action] === key
    ));
    if (conflict) {
      setError(`${reviewShortcutKeyLabel(key)} 已用于“${conflict.label}”，请先为其中一项选择其他按键。`);
      return;
    }
    const next = { ...bindings, [action]: key };
    try {
      storeReviewShortcutBindings(next);
      setBindings(next);
      setCapturing(null);
      setError("");
      setFeedback("快捷键已保存在本机，重新进入校对页后立即生效。");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "无法保存快捷键配置");
    }
  };

  const restoreDefaults = () => {
    const next = { ...DEFAULT_REVIEW_SHORTCUTS };
    try {
      storeReviewShortcutBindings(next);
      setBindings(next);
      setCapturing(null);
      setError("");
      setFeedback("已恢复默认校对快捷键。");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "无法保存快捷键配置");
    }
  };

  return (
    <div className="al-review-shortcut-settings">
      <div className="al-shortcut-settings-heading">
        <Text className="al-muted">每个按键只能绑定一个操作。选择“更改”后直接按下新键，Esc 或 Tab 可取消。</Text>
        <Button size="small" onClick={restoreDefaults}>恢复默认</Button>
      </div>
      {error && <InlineFeedback tone="error">{error}</InlineFeedback>}
      {feedback && !error && <InlineFeedback tone="info">{feedback}</InlineFeedback>}
      <div className="al-shortcut-settings-list" role="list" aria-label="可自定义校对快捷键">
        {REVIEW_SHORTCUT_OPTIONS.map(({ action, label }) => (
          <div key={action} role="listitem" className={capturing === action ? "capturing" : ""}>
            <span>{label}</span>
            <kbd>{reviewShortcutKeyLabel(bindings[action])}</kbd>
            <Button
              size="small"
              appearance={capturing === action ? "primary" : "secondary"}
              aria-label={capturing === action ? `正在设置${label}，请按新键` : `更改${label}快捷键`}
              aria-pressed={capturing === action}
              onClick={() => {
                setCapturing((current) => current === action ? null : action);
                setError("");
                setFeedback("");
              }}
              onKeyDown={(event) => captureKey(action, event)}
            >{capturing === action ? "请按新键" : "更改"}</Button>
          </div>
        ))}
      </div>
      <Text className="al-muted al-shortcut-fixed-note">
        固定操作：方向上/下仍可切换上一条/下一条，Ctrl+Z 撤销，Ctrl+Shift+Z 重做，? 打开快捷键帮助。
      </Text>
    </div>
  );
}
