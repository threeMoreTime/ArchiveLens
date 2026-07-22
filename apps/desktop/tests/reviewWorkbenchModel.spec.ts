import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEW_LAYOUT,
  REVIEW_LAYOUT_PRESETS,
  normalizeReviewLayout,
  resizeReviewLayout,
} from "../src/renderer/src/utils/reviewWorkbench";

describe("review workbench layout model", () => {
  it("keeps every pane above its professional-workbench minimum", () => {
    const normalized = normalizeReviewLayout({ image: 99, list: 1, detail: 1 });
    expect(normalized.image).toBeLessThanOrEqual(68);
    expect(normalized.list).toBeGreaterThanOrEqual(18);
    expect(normalized.detail).toBeGreaterThanOrEqual(18);
    expect(normalized.image + normalized.list + normalized.detail).toBeCloseTo(100);
  });

  it("resizes adjacent panes without changing the third pane", () => {
    const first = resizeReviewLayout(DEFAULT_REVIEW_LAYOUT, 0, 5);
    expect(first.image).toBeGreaterThan(DEFAULT_REVIEW_LAYOUT.image);
    expect(first.list).toBeLessThan(DEFAULT_REVIEW_LAYOUT.list);
    expect(first.detail).toBeCloseTo(DEFAULT_REVIEW_LAYOUT.detail);

    const second = resizeReviewLayout(DEFAULT_REVIEW_LAYOUT, 1, 4);
    expect(second.list).toBeGreaterThan(DEFAULT_REVIEW_LAYOUT.list);
    expect(second.detail).toBeLessThan(DEFAULT_REVIEW_LAYOUT.detail);
    expect(second.image).toBeCloseTo(DEFAULT_REVIEW_LAYOUT.image);
  });

  it("ships balanced, image-first and detail-first presets", () => {
    expect(REVIEW_LAYOUT_PRESETS.balanced).toEqual(DEFAULT_REVIEW_LAYOUT);
    expect(REVIEW_LAYOUT_PRESETS.image.image).toBeGreaterThan(REVIEW_LAYOUT_PRESETS.balanced.image);
    expect(REVIEW_LAYOUT_PRESETS.detail.detail).toBeGreaterThan(REVIEW_LAYOUT_PRESETS.balanced.detail);
  });
});
