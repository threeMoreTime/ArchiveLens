import { useCallback, useEffect, useRef, useState } from "react";

const RESET_WINDOW_MS = 3000;
const REQUIRED_TAPS = 7;
const HINT_FROM_TAP = 5;

interface DeveloperModeTriggerProps {
  version: string;
  onUnlocked: () => void;
}

/**
 * 隐藏开发者模式入口（任务 §七）。
 *
 * 一个安静但可聚焦的版本按钮：3 秒内连续激活 7 次即持久化开启开发者模式。
 * 第 5、6 次给出剩余次数提示，第 7 次开启；超过 3 秒未继续则计数清零。
 * 使用原生 button，鼠标点击与键盘激活行为一致；aria-live 播报后三次反馈。
 */
export function DeveloperModeTrigger({ version, onUnlocked }: DeveloperModeTriggerProps) {
  const [message, setMessage] = useState("");
  const countRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const unlockedRef = useRef(false);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => () => clearTimer(), []);

  const activate = useCallback(async () => {
    if (unlockedRef.current) return;
    clearTimer();
    countRef.current += 1;
    const count = countRef.current;

    if (count >= REQUIRED_TAPS) {
      unlockedRef.current = true;
      countRef.current = 0;
      try {
        await window.archiveLens.settings.setDeveloperMode({ enabled: true });
        setMessage("已进入开发者模式");
        onUnlocked();
      } catch {
        unlockedRef.current = false;
        setMessage("开启开发者模式失败，请重试");
      }
      return;
    }

    setMessage(count >= HINT_FROM_TAP ? `再点击 ${REQUIRED_TAPS - count} 次进入开发者模式` : "");
    timerRef.current = window.setTimeout(() => {
      countRef.current = 0;
      setMessage("");
    }, RESET_WINDOW_MS);
  }, [onUnlocked]);

  return (
    <div className="al-developer-trigger">
      <button
        type="button"
        className="al-developer-version-button"
        onClick={() => void activate()}
        aria-describedby="al-developer-trigger-status"
      >
        ArchiveLens {version}
      </button>
      <span
        id="al-developer-trigger-status"
        className="al-developer-trigger-status"
        role="status"
        aria-live="polite"
      >
        {message}
      </span>
    </div>
  );
}
