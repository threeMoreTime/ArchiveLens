import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Button, Input, Text, Textarea } from "@fluentui/react-components";

const DEFAULT_PAGE_SIZE = 100;
const PAGE_SIZES = [50, 100, 200] as const;

interface Occurrence {
  occurrence_id: string;
  file_name: string;
  page_number: number;
  matched_text: string;
  character_variant: string | null;
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

interface ReviewSummary {
  reviewed_count: number;
  unreviewed_count: number;
  confirmed_count: number;
  needs_review_count: number;
  rejected_count: number;
}

const EMPTY_SUMMARY: ReviewSummary = {
  reviewed_count: 0,
  unreviewed_count: 0,
  confirmed_count: 0,
  needs_review_count: 0,
  rejected_count: 0,
};

function assetUrl(taskId: string, rel: string | null) {
  return rel ? `al-resource://${taskId}/${rel.replace(/^\/+/, "")}` : "";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请重试";
}

export default function ReviewPage() {
  const { taskId = "" } = useParams();
  const [items, setItems] = useState<Occurrence[]>([]);
  const [total, setTotal] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [loadedPageIndex, setLoadedPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [variantFilter, setVariantFilter] = useState<string>("");
  const [searchMode, setSearchMode] = useState<string>("");
  const [search, setSearch] = useState("");
  const [reviewSummary, setReviewSummary] = useState<ReviewSummary>(EMPTY_SUMMARY);
  const [taskStatus, setTaskStatus] = useState("");
  const [scanComplete, setScanComplete] = useState(false);
  const [reviewComplete, setReviewComplete] = useState(false);
  const [loading, setLoading] = useState(false);
  const [queryError, setQueryError] = useState("");
  const [actionError, setActionError] = useState("");
  const [note, setNote] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  const requestSequenceRef = useRef(0);
  const selectLastAfterPageChange = useRef(false);
  const selectFirstAfterFilterChange = useRef(false);
  const requestedSelectedId = useRef<string | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pageStart = total === 0 ? 0 : loadedPageIndex * pageSize + 1;
  const pageEnd = Math.min(total, (loadedPageIndex + 1) * pageSize);

  const loadPage = useCallback(async (targetPage: number) => {
    const sequence = ++requestSequenceRef.current;
    setLoading(true);
    setQueryError("");
    try {
      const q = await window.archiveLens.results.query({
        task_id: taskId,
        limit: pageSize,
        offset: targetPage * pageSize,
        status: statusFilter || null,
        character: variantFilter || null,
        search: search || null,
      });
      if (sequence !== requestSequenceRef.current) return;

      const lastValidPage = Math.max(0, Math.ceil(q.total / pageSize) - 1);
      if (q.total > 0 && targetPage > lastValidPage) {
        setPageIndex(lastValidPage);
        return;
      }
      setItems(q.items);
      setTotal(q.total);
      setLoadedPageIndex(targetPage);
      setReviewSummary(q.review_summary);
      setTaskStatus(q.task_status);
      setScanComplete(q.scan_complete);
      setReviewComplete(q.review_complete);
      setSelectedId((previous) => {
        const requested = requestedSelectedId.current;
        requestedSelectedId.current = null;
        if (requested && q.items.some((item: Occurrence) => item.occurrence_id === requested)) return requested;
        if (selectFirstAfterFilterChange.current) {
          selectFirstAfterFilterChange.current = false;
          return q.items[0]?.occurrence_id ?? null;
        }
        if (previous && q.items.some((item: Occurrence) => item.occurrence_id === previous)) return previous;
        if (selectLastAfterPageChange.current) {
          selectLastAfterPageChange.current = false;
          return q.items[q.items.length - 1]?.occurrence_id ?? null;
        }
        return q.items[0]?.occurrence_id ?? null;
      });
    } catch (error) {
      if (sequence === requestSequenceRef.current) setQueryError(errorMessage(error));
    } finally {
      if (sequence === requestSequenceRef.current) setLoading(false);
    }
  }, [pageSize, search, statusFilter, taskId, variantFilter]);

  useEffect(() => {
    void loadPage(pageIndex);
  }, [loadPage, pageIndex]);

  useEffect(() => {
    window.archiveLens.tasks.get(taskId).then((task: { search_mode?: string }) => {
      setSearchMode(task.search_mode ?? "");
    }).catch((error: unknown) => setQueryError(errorMessage(error)));
  }, [taskId]);

  const selected = useMemo(
    () => items.find((item) => item.occurrence_id === selectedId) ?? null,
    [items, selectedId],
  );

  useEffect(() => {
    setNote(selected?.review_note ?? "");
    setSaveState("idle");
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, [selectedId, selected?.review_note]);

  const resetToFirstPage = (update: () => void) => {
    requestedSelectedId.current = null;
    selectFirstAfterFilterChange.current = true;
    update();
    setPageIndex(0);
  };

  const applyDecision = async (decision: "confirmed" | "needs_review" | "rejected") => {
    if (!selected) return;
    setActionError("");
    try {
      await window.archiveLens.review.updateDecision({
        task_id: taskId,
        occurrence_id: selected.occurrence_id,
        decision,
      });
      requestedSelectedId.current = selected.occurrence_id;
      await loadPage(pageIndex);
    } catch (error) {
      setActionError(`校对状态保存失败：${errorMessage(error)}`);
    }
  };

  const saveNote = async () => {
    if (!selected) return;
    setSaveState("saving");
    setActionError("");
    try {
      await window.archiveLens.review.updateNote({
        task_id: taskId,
        occurrence_id: selected.occurrence_id,
        note,
      });
      setSaveState("saved");
      requestedSelectedId.current = selected.occurrence_id;
      await loadPage(pageIndex);
    } catch (error) {
      setSaveState("error");
      setActionError(`备注保存失败：${errorMessage(error)}`);
    }
  };

  const goNext = async (pendingOnly = false) => {
    if (loading) return;
    const currentIndex = items.findIndex((item) => item.occurrence_id === selectedId);
    for (let index = currentIndex + 1; index < items.length; index += 1) {
      if (!pendingOnly || items[index]?.review_decision == null) {
        setSelectedId(items[index]!.occurrence_id);
        return;
      }
    }
    for (let nextPage = loadedPageIndex + 1; nextPage < totalPages; nextPage += 1) {
      const q = await window.archiveLens.results.query({
        task_id: taskId,
        limit: pageSize,
        offset: nextPage * pageSize,
        status: statusFilter || null,
        character: variantFilter || null,
        search: search || null,
      });
      const next = pendingOnly ? q.items.find((item: Occurrence) => item.review_decision == null) : q.items[0];
      if (next) {
        requestedSelectedId.current = next.occurrence_id;
        setPageIndex(nextPage);
        return;
      }
    }
    setActionError(pendingOnly ? "已到达最后一条未校对结果" : "已到达最后一条结果");
  };

  const goPrev = () => {
    if (loading) return;
    const currentIndex = items.findIndex((item) => item.occurrence_id === selectedId);
    if (currentIndex > 0) {
      setSelectedId(items[currentIndex - 1]!.occurrence_id);
      return;
    }
    if (loadedPageIndex > 0) {
      selectLastAfterPageChange.current = true;
      setPageIndex(loadedPageIndex - 1);
      return;
    }
    setActionError("已到达第一条结果");
  };

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (document.activeElement === noteRef.current) {
        if (event.ctrlKey && event.key === "Enter") {
          event.preventDefault();
          void saveNote();
        }
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "a") void applyDecision("confirmed");
      else if (key === "s") void applyDecision("needs_review");
      else if (key === "d") void applyDecision("rejected");
      else if (key === "j" || event.key === "ArrowDown") void goNext();
      else if (key === "k" || event.key === "ArrowUp") goPrev();
      else if (key === "n") void goNext(true);
      else if (key === "f") { setZoom(1); setOffset({ x: 0, y: 0 }); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  const onPageWheel = (event: React.WheelEvent) => {
    event.preventDefault();
    setZoom((value) => Math.min(5, Math.max(0.2, value * (event.deltaY < 0 ? 1.1 : 0.9))));
  };
  const onPageDown = (event: React.MouseEvent) => {
    dragRef.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
  };
  const onPageMove = (event: React.MouseEvent) => {
    if (!dragRef.current) return;
    setOffset({
      x: dragRef.current.ox + (event.clientX - dragRef.current.x),
      y: dragRef.current.oy + (event.clientY - dragRef.current.y),
    });
  };
  const onPageUp = () => { dragRef.current = null; };

  const confirmPartialExport = () => {
    if (scanComplete && reviewComplete) return true;
    const reason = !scanComplete
      ? "扫描尚未完成，导出仅包含当前数据库快照，结果仍可能增加。"
      : `尚有 ${reviewSummary.unreviewed_count} 条结果未校对。`;
    return window.confirm(`${reason}\n导出文件会明确标记为未完成校对。是否继续？`);
  };

  const exportHtml = async () => {
    if (!confirmPartialExport()) return;
    const result = await window.archiveLens.export.html(taskId);
    await window.archiveLens.files.openFolder(result.path.replace(/[/\\][^/\\]+$/, ""));
  };
  const exportJson = async () => {
    if (!confirmPartialExport()) return;
    const result = await window.archiveLens.export.json(taskId);
    await window.archiveLens.files.openFolder(result.path.replace(/[/\\][^/\\]+$/, ""));
  };

  return (
    <div className="al-review">
      <div className="al-review-toolbar">
        <select value={statusFilter} aria-label="校对状态筛选" onChange={(event) => resetToFirstPage(() => setStatusFilter(event.target.value))}>
          <option value="">全部校对状态</option>
          <option value="unreviewed">未校对</option>
          <option value="confirmed">已确认</option>
          <option value="needs_review">待判断</option>
          <option value="rejected">排除</option>
        </select>
        {searchMode === "legacy_fixed_pair" && (
          <select value={variantFilter} aria-label="历史字符筛选" onChange={(event) => resetToFirstPage(() => setVariantFilter(event.target.value))}>
            <option value="">全部</option>
            <option value="simplified">约</option>
            <option value="traditional">約</option>
          </select>
        )}
        <Input placeholder="搜索上下文" value={search} onChange={(_, data) => resetToFirstPage(() => setSearch(data.value))} />
        <select value={pageSize} aria-label="每页结果数" onChange={(event) => resetToFirstPage(() => setPageSize(Number(event.target.value)))}>
          {PAGE_SIZES.map((size) => <option key={size} value={size}>每页 {size} 条</option>)}
        </select>
        <Text className="al-muted">{total === 0 ? "无结果" : `第 ${pageStart}–${pageEnd} 条，共 ${total} 条`}</Text>
        <div className="al-spacer" />
        <Button onClick={exportJson}>导出 JSON</Button>
        <Button appearance="primary" onClick={exportHtml}>导出 HTML</Button>
      </div>

      <div className="al-review-summary" role="status">
        <span>{scanComplete ? "扫描已完成" : `扫描未完成（${taskStatus || "状态未知"}），当前结果仍可能增加`}</span>
        <span>已校对 {reviewSummary.reviewed_count} · 未校对 {reviewSummary.unreviewed_count}</span>
        <span>确认 {reviewSummary.confirmed_count} · 待判断 {reviewSummary.needs_review_count} · 排除 {reviewSummary.rejected_count}</span>
        <strong>{reviewComplete ? "校对已完成" : "校对未完成"}</strong>
      </div>
      {queryError && <div className="al-review-error" role="alert">查询失败：{queryError}</div>}
      {actionError && <div className="al-review-error" role="alert">{actionError}</div>}

      <div className="al-review-body">
        <div className="al-result-list" aria-busy={loading}>
          {loading && items.length === 0 && <div className="al-muted al-list-message">正在加载结果…</div>}
          {!loading && items.length === 0 && <div className="al-muted al-list-message">当前筛选没有结果</div>}
          {items.map((item) => (
            <div
              key={item.occurrence_id}
              data-occurrence-id={item.occurrence_id}
              className={"al-result-item" + (item.occurrence_id === selectedId ? " selected" : "")}
              onClick={() => setSelectedId(item.occurrence_id)}
            >
              <div className="al-result-line1">
                <span className={"al-tag al-tag-" + (item.review_decision || item.verification_status)}>{item.matched_text}</span>
                <span className="al-filename" title={item.file_name}>{item.file_name}</span>
              </div>
              <div className="al-result-line2">第 {item.page_number} 页 · 置信 {(item.ocr_confidence ?? 0).toFixed(2)}</div>
              <div className="al-result-ctx">{item.context_full}</div>
            </div>
          ))}
          <div className="al-pagination" aria-label="结果分页">
            <Button disabled={loading || pageIndex === 0} onClick={() => setPageIndex(0)}>首页</Button>
            <Button disabled={loading || pageIndex === 0} onClick={() => setPageIndex((current) => Math.max(0, current - 1))}>上一页</Button>
            <span>第 {loadedPageIndex + 1} / {totalPages} 页</span>
            <Button disabled={loading || pageIndex >= totalPages - 1} onClick={() => setPageIndex((current) => Math.min(totalPages - 1, current + 1))}>下一页</Button>
            <Button disabled={loading || pageIndex >= totalPages - 1} onClick={() => setPageIndex(totalPages - 1)}>末页</Button>
          </div>
        </div>

        <div className="al-detail">
          {!selected ? <div className="al-muted">选择左侧结果查看证据</div> : (
            <>
              <div className="al-viewer">
                {assetUrl(taskId, selected.page_image_relpath) && (
                  <div className="al-page-wrap" onWheel={onPageWheel} onMouseDown={onPageDown} onMouseMove={onPageMove} onMouseUp={onPageUp} onMouseLeave={onPageUp}>
                    <img src={assetUrl(taskId, selected.page_image_relpath)} alt="出处页" style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`, transformOrigin: "center center" }} draggable={false} />
                    <div className="al-highlight" style={{ left: `${selected.normalized_x0 * 100}%`, top: `${selected.normalized_y0 * 100}%`, width: `${(selected.normalized_x1 - selected.normalized_x0) * 100}%`, height: `${(selected.normalized_y1 - selected.normalized_y0) * 100}%` }} />
                  </div>
                )}
                {assetUrl(taskId, selected.crop_image_relpath) && <img className="al-crop" src={assetUrl(taskId, selected.crop_image_relpath)} alt="检索词截取" />}
              </div>
              <div className="al-detail-meta"><div>上下文：{selected.context_full}</div><div className="al-muted">OCR 置信 {(selected.ocr_confidence ?? 0).toFixed(2)} · 状态 {selected.verification_status}</div></div>
              <div className="al-actions">
                <Button appearance="primary" onClick={() => void applyDecision("confirmed")}>已确认 (A)</Button>
                <Button onClick={() => void applyDecision("needs_review")}>待判断 (S)</Button>
                <Button onClick={() => void applyDecision("rejected")}>排除 (D)</Button>
              </div>
              <div className="al-note-row">
                <Textarea ref={noteRef as any} value={note} onChange={(_, data) => { setNote(data.value); setSaveState("idle"); }} placeholder="备注…" className="al-note" />
                <Button onClick={() => void saveNote()}>保存 (Ctrl+Enter)</Button>
                <span className="al-save-state">{saveState === "saving" ? "保存中…" : saveState === "saved" ? "已保存" : saveState === "error" ? "保存失败，重试" : ""}</span>
              </div>
              <div className="al-nav-row">
                <Button onClick={goPrev}>上一条 (K)</Button>
                <Button onClick={() => void goNext()}>下一条 (J)</Button>
                <Button onClick={() => void goNext(true)}>下一条待处理 (N)</Button>
                <Button onClick={() => { setZoom(1); setOffset({ x: 0, y: 0 }); }}>重新居中 (F)</Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
