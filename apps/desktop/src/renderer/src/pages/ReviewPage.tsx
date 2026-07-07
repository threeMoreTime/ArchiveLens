import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Button, Input, Text, Textarea } from "@fluentui/react-components";

const PAGE_SIZE = 200;

interface Occurrence {
  occurrence_id: string;
  file_name: string;
  page_number: number;
  matched_character: string;
  character_variant: string;
  context_full: string;
  ocr_confidence: number;
  verification_status: string;
  review_decision: string | null;
  review_note: string | null;
  page_image_relpath: string | null;
  crop_image_relpath: string | null;
  normalized_x0: number;
  normalized_y0: number;
  normalized_x1: number;
  normalized_y1: number;
}

const STATUS_LABEL: Record<string, string> = {
  confirmed: "已确认",
  needs_review: "待判断",
  rejected: "排除",
};

function assetUrl(taskId: string, rel: string | null) {
  return rel ? `al-resource://${taskId}/${rel.replace(/^\/+/, "")}` : "";
}

export default function ReviewPage() {
  const { taskId = "" } = useParams();
  const [items, setItems] = useState<Occurrence[]>([]);
  const [total, setTotal] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [variantFilter, setVariantFilter] = useState<string>("");
  const [search, setSearch] = useState("");
  const [note, setNote] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);

  const reload = useCallback(async () => {
    const q = await window.archiveLens.results.query({
      task_id: taskId,
      limit: PAGE_SIZE,
      status: statusFilter || null,
      character: variantFilter || null,
      search: search || null,
    });
    setItems(q.items);
    setTotal(q.total);
    setSelectedId((prev) => (prev && q.items.some((i: Occurrence) => i.occurrence_id === prev) ? prev : (q.items[0]?.occurrence_id ?? null)));
  }, [taskId, statusFilter, variantFilter, search]);

  useEffect(() => {
    reload();
  }, [reload]);

  const selected = useMemo(
    () => items.find((i) => i.occurrence_id === selectedId) ?? null,
    [items, selectedId],
  );

  // 选中项变化时同步备注
  useEffect(() => {
    setNote(selected?.review_note ?? "");
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, [selectedId, selected?.review_note]);

  const applyDecision = async (decision: "confirmed" | "needs_review" | "rejected") => {
    if (!selected) return;
    await window.archiveLens.review.updateDecision({
      task_id: taskId,
      occurrence_id: selected.occurrence_id,
      decision,
    });
    reload();
  };

  const saveNote = async () => {
    if (!selected) return;
    setSaveState("saving");
    try {
      await window.archiveLens.review.updateNote({
        task_id: taskId,
        occurrence_id: selected.occurrence_id,
        note,
      });
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  };

  const goNext = (pendingOnly = false) => {
    const idx = items.findIndex((i) => i.occurrence_id === selectedId);
    for (let i = idx + 1; i < items.length; i++) {
      const it = items[i];
      if (!it) continue;
      if (!pendingOnly || it.review_decision == null) {
        setSelectedId(it.occurrence_id);
        return;
      }
    }
  };
  const goPrev = () => {
    const idx = items.findIndex((i) => i.occurrence_id === selectedId);
    const prev = idx > 0 ? items[idx - 1] : undefined;
    if (prev) setSelectedId(prev.occurrence_id);
  };

  // 快捷键（输入备注时不触发）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (document.activeElement === noteRef.current) return;
      const k = e.key.toLowerCase();
      if (k === "a") applyDecision("confirmed");
      else if (k === "s") applyDecision("needs_review");
      else if (k === "d") applyDecision("rejected");
      else if (k === "j" || e.key === "ArrowDown") goNext();
      else if (k === "k" || e.key === "ArrowUp") goPrev();
      else if (k === "n") goNext(true);
      else if (k === "f") { setZoom(1); setOffset({ x: 0, y: 0 }); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  const onPageWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    setZoom((z) => Math.min(5, Math.max(0.2, z * (e.deltaY < 0 ? 1.1 : 0.9))));
  };
  const onPageDown = (e: React.MouseEvent) => {
    dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
  };
  const onPageMove = (e: React.MouseEvent) => {
    if (!dragRef.current) return;
    setOffset({
      x: dragRef.current.ox + (e.clientX - dragRef.current.x),
      y: dragRef.current.oy + (e.clientY - dragRef.current.y),
    });
  };
  const onPageUp = () => { dragRef.current = null; };

  const exportHtml = async () => {
    const r = await window.archiveLens.export.html(taskId);
    await window.archiveLens.files.openFolder(r.path.replace(/[/\\][^/\\]+$/, ""));
  };
  const exportJson = async () => {
    const r = await window.archiveLens.export.json(taskId);
    await window.archiveLens.files.openFolder(r.path.replace(/[/\\][^/\\]+$/, ""));
  };

  return (
    <div className="al-review">
      <div className="al-review-toolbar">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">全部状态</option>
          <option value="confirmed">已确认</option>
          <option value="needs_review">待判断</option>
          <option value="rejected">排除</option>
        </select>
        <select value={variantFilter} onChange={(e) => setVariantFilter(e.target.value)}>
          <option value="">简繁全部</option>
          <option value="simplified">简体 约</option>
          <option value="traditional">繁体 約</option>
        </select>
        <Input placeholder="搜索上下文" value={search} onChange={(_, d) => setSearch(d.value)} />
        <Text className="al-muted">共 {total} 条</Text>
        <div className="al-spacer" />
        <Button onClick={exportJson}>导出 JSON</Button>
        <Button appearance="primary" onClick={exportHtml}>导出 HTML</Button>
      </div>

      <div className="al-review-body">
        <div className="al-result-list">
          {items.map((it) => (
            <div
              key={it.occurrence_id}
              className={"al-result-item" + (it.occurrence_id === selectedId ? " selected" : "")}
              onClick={() => setSelectedId(it.occurrence_id)}
            >
              <div className="al-result-line1">
                <span className={"al-tag al-tag-" + (it.review_decision || it.verification_status)}>
                  {it.matched_character}
                </span>
                <span className="al-filename" title={it.file_name}>{it.file_name}</span>
              </div>
              <div className="al-result-line2">
                第 {it.page_number} 页 · 置信 {(it.ocr_confidence ?? 0).toFixed(2)}
              </div>
              <div className="al-result-ctx">{it.context_full}</div>
            </div>
          ))}
        </div>

        <div className="al-detail">
          {!selected ? (
            <div className="al-muted">选择左侧结果查看证据</div>
          ) : (
            <>
              <div className="al-viewer">
                {assetUrl(taskId, selected.page_image_relpath) && (
                  <div
                    className="al-page-wrap"
                    onWheel={onPageWheel}
                    onMouseDown={onPageDown}
                    onMouseMove={onPageMove}
                    onMouseUp={onPageUp}
                    onMouseLeave={onPageUp}
                  >
                    <img
                      src={assetUrl(taskId, selected.page_image_relpath)}
                      alt="出处页"
                      style={{
                        transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
                        transformOrigin: "center center",
                      }}
                      draggable={false}
                    />
                    <div
                      className="al-highlight"
                      style={{
                        left: `${selected.normalized_x0 * 100}%`,
                        top: `${selected.normalized_y0 * 100}%`,
                        width: `${(selected.normalized_x1 - selected.normalized_x0) * 100}%`,
                        height: `${(selected.normalized_y1 - selected.normalized_y0) * 100}%`,
                      }}
                    />
                  </div>
                )}
                {assetUrl(taskId, selected.crop_image_relpath) && (
                  <img className="al-crop" src={assetUrl(taskId, selected.crop_image_relpath)} alt="字符截取" />
                )}
              </div>
              <div className="al-detail-meta">
                <div>上下文：{selected.context_full}</div>
                <div className="al-muted">
                  OCR 置信 {selected.ocr_confidence.toFixed(2)} · 状态 {selected.verification_status}
                </div>
              </div>
              <div className="al-actions">
                <Button appearance="primary" onClick={() => applyDecision("confirmed")}>已确认 (A)</Button>
                <Button onClick={() => applyDecision("needs_review")}>待判断 (S)</Button>
                <Button onClick={() => applyDecision("rejected")}>排除 (D)</Button>
              </div>
              <div className="al-note-row">
                <Textarea
                  ref={noteRef as any}
                  value={note}
                  onChange={(_, d) => { setNote(d.value); setSaveState("idle"); }}
                  placeholder="备注…"
                  className="al-note"
                />
                <Button onClick={saveNote}>保存 (Ctrl+Enter)</Button>
                <span className="al-save-state">
                  {saveState === "saving" ? "保存中…" : saveState === "saved" ? "已保存" : saveState === "error" ? "保存失败，重试" : ""}
                </span>
              </div>
              <div className="al-nav-row">
                <Button onClick={goPrev}>上一条 (K)</Button>
                <Button onClick={() => goNext()}>下一条 (J)</Button>
                <Button onClick={() => goNext(true)}>下一条待处理 (N)</Button>
                <Button onClick={() => { setZoom(1); setOffset({ x: 0, y: 0 }); }}>重新居中 (F)</Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
