import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEW_SHORTCUTS,
  getReviewShortcutAction,
  normalizeReviewShortcutKey,
  reviewShortcutKeyLabel,
} from "../src/renderer/src/utils/reviewShortcuts";

const baseEvent = {
  altKey: false,
  ctrlKey: false,
  defaultPrevented: false,
  isComposing: false,
  metaKey: false,
  repeat: false,
  target: { tagName: "DIV" } as unknown as EventTarget,
};

describe("review keyboard shortcuts", () => {
  it.each([
    ["a", "confirm"],
    ["S", "needs_review"],
    ["d", "reject"],
    ["j", "next"],
    ["ArrowDown", "next"],
    ["k", "previous"],
    ["ArrowUp", "previous"],
    ["n", "next_pending"],
    ["f", "reset_view"],
    ["i", "focus_image"],
    ["m", "toggle_note"],
    [" ", "toggle_view"],
    ["?", "shortcut_help"],
  ] as const)("maps %s to %s", (key, action) => {
    expect(getReviewShortcutAction({ ...baseEvent, key })).toBe(action);
  });

  it.each(["INPUT", "TEXTAREA", "SELECT"])("ignores %s editing targets", (tagName) => {
    expect(getReviewShortcutAction({
      ...baseEvent,
      key: "a",
      target: { tagName } as unknown as EventTarget,
    })).toBeNull();
  });

  it("ignores contenteditable and textbox descendants", () => {
    expect(getReviewShortcutAction({
      ...baseEvent,
      key: "d",
      target: { isContentEditable: true } as unknown as EventTarget,
    })).toBeNull();
    expect(getReviewShortcutAction({
      ...baseEvent,
      key: "j",
      target: { closest: () => ({}) } as unknown as EventTarget,
    })).toBeNull();
  });

  it("ignores modifiers, key repeats, IME composition and pre-handled events", () => {
    for (const override of [
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
      { repeat: true },
      { isComposing: true },
      { defaultPrevented: true },
    ]) {
      expect(getReviewShortcutAction({ ...baseEvent, key: "a", ...override })).toBeNull();
    }
  });

  it("uses a valid custom binding map without changing fixed navigation aliases", () => {
    const custom = { ...DEFAULT_REVIEW_SHORTCUTS, confirm: "q" };
    expect(getReviewShortcutAction({ ...baseEvent, key: "q" }, custom)).toBe("confirm");
    expect(getReviewShortcutAction({ ...baseEvent, key: "a" }, custom)).toBeNull();
    expect(getReviewShortcutAction({ ...baseEvent, key: "ArrowDown" }, custom)).toBe("next");
    expect(getReviewShortcutAction({ ...baseEvent, key: "?" }, custom)).toBe("shortcut_help");
  });

  it("normalizes only supported single keys and gives Space a readable label", () => {
    expect(normalizeReviewShortcutKey("Q")).toBe("q");
    expect(normalizeReviewShortcutKey(" ")).toBe(" ");
    expect(normalizeReviewShortcutKey("ArrowLeft")).toBeNull();
    expect(normalizeReviewShortcutKey("?")).toBeNull();
    expect(reviewShortcutKeyLabel(" ")).toBe("Space");
  });
});
