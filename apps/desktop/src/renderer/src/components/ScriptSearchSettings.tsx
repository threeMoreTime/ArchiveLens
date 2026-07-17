import { useEffect, useState } from "react";
import { Text } from "@fluentui/react-components";
import {
  DEFAULT_SEARCH_SCRIPT_SCOPE,
  type ReviewHighlightSettingsResult,
  type SearchScriptScope,
} from "@shared/index";
import { InlineFeedback, LoadingState } from "./feedback";

const SCRIPT_SCOPE_OPTIONS: Array<{
  value: SearchScriptScope;
  label: string;
  detail: string;
}> = [
  {
    value: "both",
    label: "简体和繁体",
    detail: "默认。简体、标准繁体、台湾和香港字形均可双向检索。",
  },
  {
    value: "simplified",
    label: "只命中简体",
    detail: "仅显示图片原字形为简体或简繁共用字的结果。",
  },
  {
    value: "traditional",
    label: "只命中繁体",
    detail: "仅显示图片原字形为繁体或简繁共用字的结果。",
  },
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "请稍后重试";
}

export function ScriptSearchSettings() {
  const [scope, setScope] = useState<SearchScriptScope>(
    DEFAULT_SEARCH_SCRIPT_SCOPE,
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    window.archiveLens.settings.get().then(
      (settings: ReviewHighlightSettingsResult) => {
        if (!active) return;
        setScope(settings.search_script_scope);
        setError("");
      },
    ).catch((loadError: unknown) => {
      if (!active) return;
      setScope(DEFAULT_SEARCH_SCRIPT_SCOPE);
      setError(`读取简繁检索设置失败：${errorMessage(loadError)}`);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  const updateScope = async (next: SearchScriptScope) => {
    const previous = scope;
    setScope(next);
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const settings = await window.archiveLens.settings.update({
        scope: "global",
        search_script_scope: next,
      });
      setScope(settings.search_script_scope);
      setSaved(true);
    } catch (saveError) {
      setScope(previous);
      setError(`保存简繁检索设置失败：${errorMessage(saveError)}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <LoadingState label="正在读取简繁检索设置…" />;
  }

  return (
    <section className="al-script-search-settings" aria-label="简繁字形检索范围">
      <fieldset disabled={saving}>
        <legend>默认命中字形</legend>
        <div className="al-script-scope-options">
          {SCRIPT_SCOPE_OPTIONS.map((option) => (
            <label
              key={option.value}
              className={scope === option.value ? "selected" : ""}
            >
              <input
                type="radio"
                name="search-script-scope"
                value={option.value}
                checked={scope === option.value}
                onChange={() => void updateScope(option.value)}
              />
              <span>
                <strong>{option.label}</strong>
                <small>{option.detail}</small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <Text className="al-muted">
        范围按图片中的 OCR 原字形判断；OpenCC 仅生成检索索引，绝不会覆盖 OCR 原文。
        混合简繁字形只在“简体和繁体”中出现。
      </Text>
      <Text role="status" className={error ? "al-highlight-save-error" : "al-muted"}>
        {error || (saving ? "正在保存…" : saved ? "已保存" : "设置会自动保存到本机")}
      </Text>
      {error && <InlineFeedback tone="warning">{error}</InlineFeedback>}
    </section>
  );
}
