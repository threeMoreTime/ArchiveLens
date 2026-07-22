import type { CSSProperties } from "react";
import type { LayoutContext } from "@shared/index";

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function layoutContextSubtitle(context: LayoutContext | null) {
  if (!context) return "正在读取命中位置";
  return context.orientation === "vertical" ? "命中列及相邻两列" : "命中行及相邻两行";
}

function LayoutContextText({ item }: { item: LayoutContext["items"][number] }) {
  const start = item.role === "target" ? item.match_start : null;
  const end = item.role === "target" ? item.match_end : null;
  if (start === null || end === null || start < 0 || end <= start || end > item.text.length) {
    return <>{item.text}</>;
  }
  return (
    <>
      {item.text.slice(0, start)}
      <mark>{item.text.slice(start, end)}</mark>
      {item.text.slice(end)}
    </>
  );
}

export function LayoutContextCanvas({ context }: { context: LayoutContext }) {
  const vertical = context.orientation === "vertical";
  const advances = context.items
    .filter((item) => item.text.length > 0)
    .map((item) => (
      vertical
        ? (item.bbox.y1 - item.bbox.y0) / item.text.length
        : (item.bbox.x1 - item.bbox.x0) / item.text.length
    ))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  const sourceAdvance = advances[Math.floor(advances.length / 2)] ?? 12;
  const desiredAdvance = vertical ? 31 : 25;
  const scale = clamp(desiredAdvance / sourceAdvance, 0.75, 4.5);
  const padding = 28;
  const sourceWidth = Math.max(1, context.bbox.x1 - context.bbox.x0);
  const sourceHeight = Math.max(1, context.bbox.y1 - context.bbox.y0);
  const canvasWidth = Math.max(vertical ? 260 : 520, sourceWidth * scale + padding * 2);
  const canvasHeight = Math.max(vertical ? 520 : 180, sourceHeight * scale + padding * 2);

  return (
    <div className={`al-layout-context-viewport ${context.orientation}`} tabIndex={0} aria-label={layoutContextSubtitle(context)}>
      <div className="al-layout-context-canvas" style={{ width: canvasWidth, height: canvasHeight }}>
        {context.items.map((item) => {
          const style = {
            left: padding + (item.bbox.x0 - context.bbox.x0) * scale,
            top: padding + (item.bbox.y0 - context.bbox.y0) * scale,
            minWidth: Math.max(24, (item.bbox.x1 - item.bbox.x0) * scale),
            minHeight: Math.max(24, (item.bbox.y1 - item.bbox.y0) * scale),
          } satisfies CSSProperties;
          return (
            <span
              key={`${item.ocr_line_id || "line"}-${item.line_index}`}
              className={`al-layout-context-line ${item.role}`}
              style={style}
            >
              <LayoutContextText item={item} />
            </span>
          );
        })}
      </div>
    </div>
  );
}
