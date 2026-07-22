export type ReviewShortcutAction =
  | "confirm"
  | "needs_review"
  | "reject"
  | "next"
  | "previous"
  | "next_pending"
  | "reset_view"
  | "toggle_view"
  | "focus_image"
  | "toggle_note"
  | "shortcut_help";

export type ConfigurableReviewShortcutAction = Exclude<ReviewShortcutAction, "shortcut_help">;
export type ReviewShortcutBindings = Record<ConfigurableReviewShortcutAction, string>;

export const REVIEW_SHORTCUT_STORAGE_KEY = "archivelens.reviewShortcuts.v1";

export const REVIEW_SHORTCUT_OPTIONS: ReadonlyArray<{
  action: ConfigurableReviewShortcutAction;
  label: string;
}> = [
  { action: "confirm", label: "确认命中" },
  { action: "needs_review", label: "标记待复核" },
  { action: "reject", label: "拒绝命中" },
  { action: "next", label: "下一条" },
  { action: "previous", label: "上一条" },
  { action: "next_pending", label: "下一条待处理" },
  { action: "reset_view", label: "重新居中页面" },
  { action: "toggle_view", label: "适应页面或原始比例" },
  { action: "focus_image", label: "图像专注" },
  { action: "toggle_note", label: "编辑备注" },
];

export const DEFAULT_REVIEW_SHORTCUTS: Readonly<ReviewShortcutBindings> = {
  confirm: "a",
  needs_review: "s",
  reject: "d",
  next: "j",
  previous: "k",
  next_pending: "n",
  reset_view: "f",
  toggle_view: " ",
  focus_image: "i",
  toggle_note: "m",
};

type ShortcutEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "defaultPrevented" | "isComposing" | "key" | "metaKey" | "repeat" | "target"
>;

function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  const element = target as {
    tagName?: string;
    isContentEditable?: boolean;
    getAttribute?: (name: string) => string | null;
    closest?: (selector: string) => unknown;
  };
  const tagName = element.tagName?.toLowerCase();
  if (tagName === "input" || tagName === "textarea" || tagName === "select") return true;
  if (element.isContentEditable) return true;
  if (element.getAttribute?.("role") === "textbox") return true;
  return Boolean(element.closest?.("input, textarea, select, [contenteditable='true'], [role='textbox']"));
}

export function normalizeReviewShortcutKey(key: string): string | null {
  if (key === " ") return " ";
  if (key.length !== 1 || !/[a-z0-9]/i.test(key)) return null;
  return key.toLowerCase();
}

export function reviewShortcutKeyLabel(key: string): string {
  if (key === " ") return "Space";
  return key.toUpperCase();
}

function validatedBindings(value: unknown): ReviewShortcutBindings | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const result = {} as ReviewShortcutBindings;
  const used = new Set<string>();
  for (const { action } of REVIEW_SHORTCUT_OPTIONS) {
    const raw = record[action];
    const key = typeof raw === "string" ? normalizeReviewShortcutKey(raw) : null;
    if (!key || used.has(key)) return null;
    result[action] = key;
    used.add(key);
  }
  return result;
}

export function readReviewShortcutBindings(): ReviewShortcutBindings {
  try {
    if (typeof localStorage === "undefined") return { ...DEFAULT_REVIEW_SHORTCUTS };
    const parsed: unknown = JSON.parse(localStorage.getItem(REVIEW_SHORTCUT_STORAGE_KEY) ?? "null");
    return validatedBindings(parsed) ?? { ...DEFAULT_REVIEW_SHORTCUTS };
  } catch {
    return { ...DEFAULT_REVIEW_SHORTCUTS };
  }
}

export function storeReviewShortcutBindings(bindings: ReviewShortcutBindings): void {
  const validated = validatedBindings(bindings);
  if (!validated) throw new Error("快捷键配置包含无效或重复按键");
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(REVIEW_SHORTCUT_STORAGE_KEY, JSON.stringify(validated));
    }
  } catch {
    throw new Error("无法保存快捷键配置");
  }
}

/** 将安全的全局按键映射为校对动作；编辑、组合输入和修饰键场景一律忽略。 */
export function getReviewShortcutAction(
  event: ShortcutEvent,
  bindings: Readonly<ReviewShortcutBindings> = DEFAULT_REVIEW_SHORTCUTS,
): ReviewShortcutAction | null {
  if (
    event.defaultPrevented
    || event.isComposing
    || event.repeat
    || event.altKey
    || event.ctrlKey
    || event.metaKey
    || isEditableTarget(event.target)
  ) {
    return null;
  }
  if (event.key === "?") return "shortcut_help";
  if (event.key === "ArrowDown") return "next";
  if (event.key === "ArrowUp") return "previous";
  const key = normalizeReviewShortcutKey(event.key);
  if (!key) return null;
  return REVIEW_SHORTCUT_OPTIONS.find(({ action }) => bindings[action] === key)?.action ?? null;
}
