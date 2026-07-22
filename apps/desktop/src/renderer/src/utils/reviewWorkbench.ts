export type ReviewDecision = "confirmed" | "needs_review" | "rejected" | null;
export type ReviewDensity = "compact" | "comfortable";

export interface ReviewLayoutRatios {
  image: number;
  list: number;
  detail: number;
}

export const DEFAULT_REVIEW_LAYOUT: ReviewLayoutRatios = { image: 50, list: 27, detail: 23 };
export const REVIEW_LAYOUT_PRESETS: Record<"balanced" | "image" | "detail", ReviewLayoutRatios> = {
  balanced: DEFAULT_REVIEW_LAYOUT,
  image: { image: 60, list: 22, detail: 18 },
  detail: { image: 43, list: 24, detail: 33 },
};

const LAYOUT_STORAGE_KEY = "archivelens.reviewLayout.v1";
const DENSITY_STORAGE_KEY = "archivelens.reviewDensity.v1";
const POSITION_STORAGE_PREFIX = "archivelens.reviewPosition.";

function validRatio(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function normalizeReviewLayout(value: ReviewLayoutRatios): ReviewLayoutRatios {
  const minimums: ReviewLayoutRatios = { image: 30, list: 18, detail: 18 };
  const maximums: ReviewLayoutRatios = { image: 68, list: 40, detail: 42 };
  const normalized: ReviewLayoutRatios = {
    image: Math.max(minimums.image, Math.min(maximums.image, value.image)),
    list: Math.max(minimums.list, Math.min(maximums.list, value.list)),
    detail: Math.max(minimums.detail, Math.min(maximums.detail, value.detail)),
  };
  const keys: Array<keyof ReviewLayoutRatios> = ["image", "list", "detail"];
  const total = keys.reduce((sum, key) => sum + normalized[key], 0);
  const difference = 100 - total;

  if (Math.abs(difference) < Number.EPSILON) return normalized;

  const available = keys.map((key) => difference > 0
    ? maximums[key] - normalized[key]
    : normalized[key] - minimums[key]);
  const totalAvailable = available.reduce((sum, amount) => sum + amount, 0);

  keys.forEach((key, index) => {
    normalized[key] += difference * (available[index]! / totalAvailable);
  });
  return normalized;
}

export function resizeReviewLayout(
  layout: ReviewLayoutRatios,
  divider: 0 | 1,
  deltaPercent: number,
): ReviewLayoutRatios {
  if (divider === 0) {
    const delta = Math.max(30 - layout.image, Math.min(layout.list - 18, deltaPercent));
    return normalizeReviewLayout({ ...layout, image: layout.image + delta, list: layout.list - delta });
  }
  const delta = Math.max(18 - layout.list, Math.min(layout.detail - 18, deltaPercent));
  return normalizeReviewLayout({ ...layout, list: layout.list + delta, detail: layout.detail - delta });
}

export function readReviewLayout(): ReviewLayoutRatios {
  try {
    const parsed = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) ?? "null") as Partial<ReviewLayoutRatios> | null;
    if (parsed && validRatio(parsed.image) && validRatio(parsed.list) && validRatio(parsed.detail)) {
      return normalizeReviewLayout({ image: parsed.image, list: parsed.list, detail: parsed.detail });
    }
  } catch {
    // Fall through to the stable default when local preferences are unavailable.
  }
  return DEFAULT_REVIEW_LAYOUT;
}

export function storeReviewLayout(layout: ReviewLayoutRatios): void {
  try { localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(normalizeReviewLayout(layout))); } catch { /* Session state remains usable. */ }
}

export function readReviewDensity(): ReviewDensity {
  try { return localStorage.getItem(DENSITY_STORAGE_KEY) === "comfortable" ? "comfortable" : "compact"; } catch { return "compact"; }
}

export function storeReviewDensity(density: ReviewDensity): void {
  try { localStorage.setItem(DENSITY_STORAGE_KEY, density); } catch { /* Session state remains usable. */ }
}

export function readReviewPosition(taskId: string): number {
  try {
    const value = Number(localStorage.getItem(POSITION_STORAGE_PREFIX + taskId));
    return Number.isInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

export function storeReviewPosition(taskId: string, index: number): void {
  try { localStorage.setItem(POSITION_STORAGE_PREFIX + taskId, String(Math.max(0, Math.floor(index)))); } catch { /* Position restore is best effort. */ }
}
