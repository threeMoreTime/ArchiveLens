export type ReviewShortcutAction =
  | "confirm"
  | "needs_review"
  | "reject"
  | "next"
  | "previous"
  | "next_pending"
  | "reset_view";

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

/** 将安全的全局按键映射为校对动作；编辑、组合输入和修饰键场景一律忽略。 */
export function getReviewShortcutAction(event: ShortcutEvent): ReviewShortcutAction | null {
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
  const key = event.key.toLowerCase();
  if (key === "a") return "confirm";
  if (key === "s") return "needs_review";
  if (key === "d") return "reject";
  if (key === "j" || event.key === "ArrowDown") return "next";
  if (key === "k" || event.key === "ArrowUp") return "previous";
  if (key === "n") return "next_pending";
  if (key === "f") return "reset_view";
  return null;
}
