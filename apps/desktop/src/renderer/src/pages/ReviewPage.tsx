import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button, Input, Text, Textarea } from "@fluentui/react-components";
import {
  ArrowDownRegular,
  ArrowLeftRegular,
  ArrowResetRegular,
  ArrowRightRegular,
  ArrowUpRegular,
  FullScreenMaximizeRegular,
  PanelRightContractRegular,
  PanelRightExpandRegular,
  ZoomInRegular,
  ZoomOutRegular,
} from "@fluentui/react-icons";
import {
  DEFAULT_REVIEW_HIGHLIGHT_STYLE,
  DEFAULT_REVIEW_PAGE_ORIENTATION,
  type ReviewHighlightSettingsResult,
  type ReviewHighlightStyle,
  type ReviewPageImageResult,
  type ReviewPageOrientation,
  type ReviewPageOrientations,
} from "@shared/index";
import { InlineFeedback, LoadingState, PageHeader } from "../components/feedback";
import { highlightBackground } from "../components/ReviewHighlightSettings";
import { getReviewShortcutAction } from "../utils/reviewShortcuts";

const DEFAULT_PAGE_SIZE = 100;
const PAGE_SIZES = [50, 100, 200] as const;
const NOTE_DRAFT_PREFIX = "archivelens.reviewDraft.";
const REVIEW_SUMMARY_COLLAPSED_KEY = "archivelens.reviewSummaryCollapsed";
const PAGE_ORIENTATION_DEGREES: Record<ReviewPageOrientation, number> = {
  up: 0,
  right: 90,
  down: 180,
  left: 270,
};
const PAGE_ORIENTATION_OPTIONS: Array<{
  value: ReviewPageOrientation;
  label: string;
  icon: JSX.Element;
}> = [
  { value: "up", label: "页面朝上（0°）", icon: <ArrowUpRegular /> },
  { value: "right", label: "页面朝右（90°）", icon: <ArrowRightRegular /> },
  { value: "down", label: "页面朝下（180°）", icon: <ArrowDownRegular /> },
  { value: "left", label: "页面朝左（270°）", icon: <ArrowLeftRegular /> },
];

interface Occurrence {
  occurrence_id: string;
  document_id: string;
  file_path: string;
  file_name: string;
  page_number: number;
  matched_text: string;
  character_variant: string | null;
  context_full: string;
  ocr_confidence: number | null;
  verification_status: string;
  review_decision: string | null;
  review_note: string | null;
  page_image_relpath: string | null;
  crop_image_relpath: string | null;
  page_image_width: number | null;
  page_image_height: number | null;
  source_page_width: number | null;
  source_page_height: number | null;
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

function assetUrl(taskId: string, rel: string | null, version?: string) {
  if (!rel) return "";
  const query = version ? `?v=${encodeURIComponent(version)}` : "";
  return `al-resource://${taskId}/${rel.replace(/^\/+/, "")}${query}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请重试";
}

function confidenceLabel(value: number | null) {
  return typeof value === "number" ? value.toFixed(2) : "未提供置信度";
}

function verificationLabel(status: string) {
  const labels: Record<string, string> = {
    confirmed: "系统判断可信",
    needs_review: "系统建议人工复核",
    rejected: "系统判断不匹配",
  };
  return labels[status] ?? "系统状态未知";
}

function decisionLabel(decision: string | null) {
  const labels: Record<string, string> = {
    confirmed: "已确认",
    needs_review: "待复核",
    rejected: "已拒绝",
  };
  return decision ? labels[decision] ?? "未知结论" : "未校对";
}

function noteDraftKey(taskId: string, occurrenceId: string) {
  return `${NOTE_DRAFT_PREFIX}${taskId}:${occurrenceId}`;
}

function readStoredDraft(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function storeDraft(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* The in-memory draft remains available. */ }
}

function clearStoredDraft(key: string): void {
  try { localStorage.removeItem(key); } catch { /* A matching stale draft is harmless and will retry. */ }
}

export default function ReviewPage() {
  const { taskId = "" } = useParams();
  const nav = useNavigate();
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
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [pageImage, setPageImage] = useState<ReviewPageImageResult | null>(null);
  const [pageImageLoading, setPageImageLoading] = useState(false);
  const [pageImageError, setPageImageError] = useState("");
  const [pageOrientations, setPageOrientations] = useState<ReviewPageOrientations>({});
  const [orientationSaving, setOrientationSaving] = useState(false);
  const [summaryCollapsed, setSummaryCollapsed] = useState(() => {
    try { return localStorage.getItem(REVIEW_SUMMARY_COLLAPSED_KEY) === "true"; } catch { return false; }
  });
  const [highlightStyle, setHighlightStyle] = useState<ReviewHighlightStyle>(DEFAULT_REVIEW_HIGHLIGHT_STYLE);
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const pageWrapRef = useRef<HTMLDivElement | null>(null);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  const requestSequenceRef = useRef(0);
  const pageImageRequestRef = useRef(0);
  const fitWhenReadyRef = useRef(false);
  const persistedPageOrientationsRef = useRef<ReviewPageOrientations>({});
  const selectLastAfterPageChange = useRef(false);
  const selectFirstAfterFilterChange = useRef(false);
  const requestedSelectedId = useRef<string | null>(null);
  const selectedRef = useRef<{ taskId: string; id: string } | null>(null);
  const noteDraftsRef = useRef(new Map<string, string>());
  const savedNotesRef = useRef(new Map<string, string>());
  const noteSaveQueuesRef = useRef(new Map<string, Promise<boolean>>());
  const noteSnapshotRef = useRef<{ taskId: string | null; id: string | null; value: string }>({ taskId: null, id: null, value: "" });
  const currentTaskIdRef = useRef(taskId);
  currentTaskIdRef.current = taskId;

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pageStart = total === 0 ? 0 : loadedPageIndex * pageSize + 1;
  const pageEnd = Math.min(total, (loadedPageIndex + 1) * pageSize);
  const selected = useMemo(
    () => items.find((item) => item.occurrence_id === selectedId) ?? null,
    [items, selectedId],
  );
  const pageOrientation = selected
    ? pageOrientations[selected.document_id] ?? DEFAULT_REVIEW_PAGE_ORIENTATION
    : DEFAULT_REVIEW_PAGE_ORIENTATION;
  const orientationSwapsAxes = pageOrientation === "right" || pageOrientation === "left";
  const displayedSize = useMemo(() => ({
    width: (pageImage?.width_100_css ?? 0) * zoom,
    height: (pageImage?.height_100_css ?? 0) * zoom,
  }), [pageImage?.height_100_css, pageImage?.width_100_css, zoom]);
  const visualSize = useMemo(() => orientationSwapsAxes ? ({
    width: displayedSize.height,
    height: displayedSize.width,
  }) : displayedSize, [displayedSize, orientationSwapsAxes]);
  const zoomPercent = Math.round(zoom * 100);
  const resetPageViewportScroll = useCallback(() => {
    const viewport = pageWrapRef.current;
    if (!viewport || (viewport.scrollLeft === 0 && viewport.scrollTop === 0)) return;
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
  }, []);

  useEffect(() => {
    resetPageViewportScroll();
  }, [resetPageViewportScroll, visualSize.height, visualSize.width]);

  useEffect(() => {
    try { localStorage.setItem(REVIEW_SUMMARY_COLLAPSED_KEY, String(summaryCollapsed)); } catch { /* Preference remains active for this session. */ }
  }, [summaryCollapsed]);

  useEffect(() => {
    const viewport = pageWrapRef.current;
    if (!viewport) return;
    const updateSize = () => setViewportSize({ width: viewport.clientWidth, height: viewport.clientHeight });
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [selectedId, summaryCollapsed]);

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
    requestSequenceRef.current += 1;
    setItems([]);
    setTotal(0);
    setPageIndex(0);
    setLoadedPageIndex(0);
    setSelectedId(null);
    setReviewSummary(EMPTY_SUMMARY);
    setTaskStatus("");
    setScanComplete(false);
    setReviewComplete(false);
    setQueryError("");
    setActionError("");
    setPageOrientations({});
    persistedPageOrientationsRef.current = {};
    setOrientationSaving(false);
  }, [taskId]);

  useEffect(() => {
    let active = true;
    window.archiveLens.settings.get(taskId).then((result: ReviewHighlightSettingsResult) => {
      if (!active) return;
      setHighlightStyle(result.effective);
      setPageOrientations(result.page_orientations);
      persistedPageOrientationsRef.current = result.page_orientations;
    }).catch((error: unknown) => {
      if (!active) return;
      setHighlightStyle(DEFAULT_REVIEW_HIGHLIGHT_STYLE);
      setPageOrientations({});
      persistedPageOrientationsRef.current = {};
      setActionError(`读取校对显示设置失败：${errorMessage(error)}。当前使用默认高亮且页面朝上。`);
    });
    return () => { active = false; };
  }, [taskId]);

  useEffect(() => {
    void loadPage(pageIndex);
  }, [loadPage, pageIndex]);

  useEffect(() => {
    window.archiveLens.tasks.get(taskId).then((task: { search_mode?: string }) => {
      setSearchMode(task.search_mode ?? "");
    }).catch((error: unknown) => setQueryError(errorMessage(error)));
  }, [taskId]);

  useEffect(() => {
    if (!selected || viewportSize.width <= 0 || viewportSize.height <= 0) return;
    const requestId = ++pageImageRequestRef.current;
    let active = true;
    const timer = window.setTimeout(() => {
      setPageImageLoading(true);
      setPageImageError("");
      const targetWidth = pageImage?.width_100_css
        ? pageImage.width_100_css * zoom
        : viewportSize.width;
      const targetHeight = pageImage?.height_100_css
        ? pageImage.height_100_css * zoom
        : viewportSize.height;
      void window.archiveLens.review.preparePageImage({
        task_id: taskId,
        occurrence_id: selected.occurrence_id,
        target_css_width: Math.max(1, targetWidth),
        target_css_height: Math.max(1, targetHeight),
        device_pixel_ratio: Math.min(4, Math.max(0.5, window.devicePixelRatio || 1)),
      }).then((result: ReviewPageImageResult) => {
        if (!active || requestId !== pageImageRequestRef.current) return;
        setPageImage(result);
        if (fitWhenReadyRef.current) {
          fitWhenReadyRef.current = false;
          const baseWidth = orientationSwapsAxes ? result.height_100_css : result.width_100_css;
          const baseHeight = orientationSwapsAxes ? result.width_100_css : result.height_100_css;
          setZoom(Math.min(
            1,
            viewportSize.width / baseWidth,
            viewportSize.height / baseHeight,
          ));
          setOffset({ x: 0, y: 0 });
        }
      }).catch((error: unknown) => {
        if (!active || requestId !== pageImageRequestRef.current) return;
        setPageImageError(errorMessage(error));
      }).finally(() => {
        if (active && requestId === pageImageRequestRef.current) setPageImageLoading(false);
      });
    }, 150);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [
    pageImage?.height_100_css,
    pageImage?.width_100_css,
    selected,
    taskId,
    orientationSwapsAxes,
    viewportSize.height,
    viewportSize.width,
    zoom,
  ]);

  const persistNote = useCallback((targetTaskId: string, occurrenceId: string, value: string): Promise<boolean> => {
    const draftKey = noteDraftKey(targetTaskId, occurrenceId);
    const previous = noteSaveQueuesRef.current.get(draftKey) ?? Promise.resolve(true);
    const queued = previous.catch(() => false).then(async () => {
      if (savedNotesRef.current.get(draftKey) === value) {
        if (readStoredDraft(draftKey) === value) clearStoredDraft(draftKey);
        return true;
      }
      const isSelected = selectedRef.current?.taskId === targetTaskId && selectedRef.current.id === occurrenceId;
      if (isSelected) setSaveState("saving");
      try {
        await window.archiveLens.review.updateNote({ task_id: targetTaskId, occurrence_id: occurrenceId, note: value });
        savedNotesRef.current.set(draftKey, value);
        if (readStoredDraft(draftKey) === value) clearStoredDraft(draftKey);
        if (selectedRef.current?.taskId === targetTaskId && selectedRef.current.id === occurrenceId) {
          const currentDraft = noteDraftsRef.current.get(draftKey) ?? "";
          setSaveState(currentDraft === value ? "saved" : "saving");
        }
        return true;
      } catch (error) {
        if (selectedRef.current?.taskId === targetTaskId && selectedRef.current.id === occurrenceId) setSaveState("error");
        if (targetTaskId === currentTaskIdRef.current) {
          setActionError(`备注保存失败：${errorMessage(error)}。草稿已保留在本机；请重试保存后再离开当前结果。`);
        }
        return false;
      }
    });
    noteSaveQueuesRef.current.set(draftKey, queued);
    void queued.finally(() => {
      if (noteSaveQueuesRef.current.get(draftKey) === queued) noteSaveQueuesRef.current.delete(draftKey);
    });
    return queued;
  }, []);

  const flushCurrentNote = useCallback(async () => {
    const snapshot = noteSnapshotRef.current;
    if (!snapshot.taskId || !snapshot.id) return true;
    const draftKey = noteDraftKey(snapshot.taskId, snapshot.id);
    if (savedNotesRef.current.get(draftKey) === snapshot.value) return true;
    return persistNote(snapshot.taskId, snapshot.id, snapshot.value);
  }, [persistNote]);

  useEffect(() => {
    const occurrenceId = selected?.occurrence_id ?? null;
    selectedRef.current = occurrenceId ? { taskId, id: occurrenceId } : null;
    if (!occurrenceId) {
      noteSnapshotRef.current = { taskId: null, id: null, value: "" };
      setNote("");
      setSaveState("idle");
      return;
    }
    const draftKey = noteDraftKey(taskId, occurrenceId);
    const persisted = selected?.review_note ?? "";
    if (!savedNotesRef.current.has(draftKey)) savedNotesRef.current.set(draftKey, persisted);
    const draft = noteDraftsRef.current.get(draftKey) ?? readStoredDraft(draftKey) ?? persisted;
    noteDraftsRef.current.set(draftKey, draft);
    noteSnapshotRef.current = { taskId, id: occurrenceId, value: draft };
    setNote(draft);
    setSaveState(savedNotesRef.current.get(draftKey) === draft ? "idle" : "saving");
    return () => {
      const snapshot = noteSnapshotRef.current;
      if (snapshot.taskId === taskId && snapshot.id === occurrenceId && savedNotesRef.current.get(draftKey) !== snapshot.value) {
        void persistNote(taskId, occurrenceId, snapshot.value);
      }
    };
  }, [persistNote, selected?.occurrence_id, selected?.review_note, taskId]);

  useEffect(() => {
    pageImageRequestRef.current += 1;
    fitWhenReadyRef.current = false;
    setPageImage(null);
    setPageImageLoading(false);
    setPageImageError("");
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, [selected?.occurrence_id]);

  useEffect(() => {
    if (!selectedId || savedNotesRef.current.get(noteDraftKey(taskId, selectedId)) === note) return;
    const timer = window.setTimeout(() => { void persistNote(taskId, selectedId, note); }, 700);
    return () => window.clearTimeout(timer);
  }, [note, persistNote, selectedId, taskId]);

  const resetToFirstPage = async (update: () => void) => {
    if (!(await flushCurrentNote())) return;
    requestedSelectedId.current = null;
    selectFirstAfterFilterChange.current = true;
    update();
    setPageIndex(0);
  };

  const applyDecision = async (decision: "confirmed" | "needs_review" | "rejected") => {
    if (!selected) return;
    setActionError("");
    try {
      if (!(await flushCurrentNote())) return;
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
    if (!selectedId) return;
    setActionError("");
    await persistNote(taskId, selectedId, note);
  };

  const goNext = async (pendingOnly = false) => {
    if (loading) return;
    if (!(await flushCurrentNote())) return;
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

  const goPrev = async () => {
    if (loading) return;
    if (!(await flushCurrentNote())) return;
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
      const action = getReviewShortcutAction(event);
      if (!action) return;
      event.preventDefault();
      if (action === "confirm") void applyDecision("confirmed");
      else if (action === "needs_review") void applyDecision("needs_review");
      else if (action === "reject") void applyDecision("rejected");
      else if (action === "next") void goNext();
      else if (action === "previous") void goPrev();
      else if (action === "next_pending") void goNext(true);
      else if (action === "reset_view") setOffset({ x: 0, y: 0 });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  const onPageWheel = (event: React.WheelEvent) => {
    event.preventDefault();
    fitWhenReadyRef.current = false;
    setZoom((value) => Math.min(4, Math.max(0.02, value * (event.deltaY < 0 ? 1.12 : 0.88))));
  };
  const zoomBy = (factor: number) => {
    fitWhenReadyRef.current = false;
    setZoom((value) => Math.min(4, Math.max(0.02, value * factor)));
  };
  const fitPage = () => {
    if (!pageImage) {
      fitWhenReadyRef.current = true;
      return;
    }
    fitWhenReadyRef.current = false;
    const baseWidth = orientationSwapsAxes ? pageImage.height_100_css : pageImage.width_100_css;
    const baseHeight = orientationSwapsAxes ? pageImage.width_100_css : pageImage.height_100_css;
    setZoom(Math.min(
      1,
      viewportSize.width / baseWidth,
      viewportSize.height / baseHeight,
    ));
    setOffset({ x: 0, y: 0 });
  };
  const recenterPage = () => setOffset({ x: 0, y: 0 });
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

  const changePageOrientation = async (nextOrientation: ReviewPageOrientation) => {
    if (!selected || orientationSaving || nextOrientation === pageOrientation) return;
    const targetTaskId = taskId;
    const documentId = selected.document_id;
    const previousOrientations = persistedPageOrientationsRef.current;
    setPageOrientations((current) => ({ ...current, [documentId]: nextOrientation }));
    setOffset({ x: 0, y: 0 });
    setActionError("");
    setOrientationSaving(true);
    try {
      const result = await window.archiveLens.settings.update({
        scope: "document",
        task_id: targetTaskId,
        document_id: documentId,
        orientation: nextOrientation,
      });
      if (currentTaskIdRef.current !== targetTaskId) return;
      persistedPageOrientationsRef.current = result.page_orientations;
      setPageOrientations(result.page_orientations);
    } catch (error) {
      if (currentTaskIdRef.current !== targetTaskId) return;
      setPageOrientations(previousOrientations);
      setActionError(`保存页面展示方向失败：${errorMessage(error)}。已恢复上次保存的方向。`);
    } finally {
      if (currentTaskIdRef.current === targetTaskId) setOrientationSaving(false);
    }
  };

  const selectOccurrence = async (occurrenceId: string) => {
    if (occurrenceId === selectedId) return;
    if (!(await flushCurrentNote())) return;
    setSelectedId(occurrenceId);
  };

  const changePage = async (nextPage: number) => {
    if (!(await flushCurrentNote())) return;
    setPageIndex(Math.min(totalPages - 1, Math.max(0, nextPage)));
  };

  const updateNoteDraft = (value: string) => {
    setNote(value);
    setActionError("");
    if (selectedId) {
      const draftKey = noteDraftKey(taskId, selectedId);
      noteDraftsRef.current.set(draftKey, value);
      noteSnapshotRef.current = { taskId, id: selectedId, value };
      if (savedNotesRef.current.get(draftKey) === value) clearStoredDraft(draftKey);
      else storeDraft(draftKey, value);
    }
    setSaveState("idle");
  };

  const goToExport = async () => {
    if (await flushCurrentNote()) nav(`/export/${taskId}`);
  };

  return (
    <div
      className="al-review"
      style={{ "--al-review-highlight": highlightBackground(highlightStyle) } as CSSProperties}
    >
      <div className="al-review-title"><PageHeader title="校对工作台" description="逐条确认 OCR 命中结果，所有校对与备注均保存到本地任务。" /></div>
      <div className="al-review-toolbar">
        <select value={statusFilter} aria-label="校对状态筛选" onChange={(event) => void resetToFirstPage(() => setStatusFilter(event.target.value))}>
          <option value="">全部校对状态</option>
          <option value="unreviewed">未校对</option>
          <option value="confirmed">已确认</option>
          <option value="needs_review">待复核</option>
          <option value="rejected">已拒绝</option>
        </select>
        {searchMode === "legacy_fixed_pair" && (
          <select value={variantFilter} aria-label="历史字符筛选" onChange={(event) => void resetToFirstPage(() => setVariantFilter(event.target.value))}>
            <option value="">全部</option>
            <option value="simplified">约</option>
            <option value="traditional">約</option>
          </select>
        )}
        <Input aria-label="搜索结果上下文" placeholder="搜索上下文" value={search} onChange={(_, data) => void resetToFirstPage(() => setSearch(data.value))} />
        <select value={pageSize} aria-label="每页结果数" onChange={(event) => void resetToFirstPage(() => setPageSize(Number(event.target.value)))}>
          {PAGE_SIZES.map((size) => <option key={size} value={size}>每页 {size} 条</option>)}
        </select>
        <Text className="al-muted">{total === 0 ? "无结果" : `第 ${pageStart}–${pageEnd} 条，共 ${total} 条`}</Text>
        <div className="al-spacer" />
        <Button appearance="primary" onClick={() => void goToExport()}>前往导出中心</Button>
      </div>

      <div className="al-review-summary" role="status">
        <span>{scanComplete ? "扫描已完成" : `扫描未完成（${taskStatus || "状态未知"}），当前结果仍可能增加`}</span>
        <span>已校对 {reviewSummary.reviewed_count} · 未校对 {reviewSummary.unreviewed_count}</span>
        <span>已确认 {reviewSummary.confirmed_count} · 待复核 {reviewSummary.needs_review_count} · 已拒绝 {reviewSummary.rejected_count}</span>
        <strong>{reviewComplete ? "校对已完成" : "校对未完成"}</strong>
      </div>
      {queryError && <InlineFeedback>{`查询失败：${queryError}`}</InlineFeedback>}
      {actionError && <InlineFeedback>{actionError}</InlineFeedback>}

      <div className="al-review-body">
        <div className="al-result-list" role="listbox" aria-label="校对结果" aria-busy={loading}>
          <div className="al-result-scroll">
            {loading && items.length === 0 && <div className="al-list-message"><LoadingState label="正在加载校对结果…" /></div>}
            {!loading && items.length === 0 && <div className="al-list-message"><Text weight="semibold">当前筛选没有结果</Text><Text className="al-muted">调整筛选条件，或返回任务查看扫描状态。</Text></div>}
            {items.map((item) => (
              <button
                type="button"
                role="option"
                aria-selected={item.occurrence_id === selectedId}
                key={item.occurrence_id}
                data-occurrence-id={item.occurrence_id}
                className={"al-result-item" + (item.occurrence_id === selectedId ? " selected" : "")}
                onClick={() => void selectOccurrence(item.occurrence_id)}
              >
                <div className="al-result-item-content">
                  <div className="al-result-thumbnail">
                    {assetUrl(taskId, item.page_image_relpath) ? (
                      <div className="al-result-thumbnail-canvas">
                        <img src={assetUrl(taskId, item.page_image_relpath)} alt="" loading="lazy" draggable={false} />
                        <div className="al-result-thumbnail-highlight" style={{ left: `${item.normalized_x0 * 100}%`, top: `${item.normalized_y0 * 100}%`, width: `${(item.normalized_x1 - item.normalized_x0) * 100}%`, height: `${(item.normalized_y1 - item.normalized_y0) * 100}%` }} />
                      </div>
                    ) : <div className="al-result-thumbnail-empty">页面预览不可用</div>}
                  </div>
                  <div className="al-result-summary-content">
                    <div className="al-result-line1">
                      <span className={"al-tag al-tag-" + (item.review_decision || item.verification_status)}>{item.matched_text}</span>
                      <span className="al-filename" title={item.file_name}>{item.file_name}</span>
                    </div>
                    <div className="al-result-line2">第 {item.page_number} 页 · 置信 {confidenceLabel(item.ocr_confidence)} · {decisionLabel(item.review_decision)}</div>
                  </div>
                </div>
              </button>
            ))}
          </div>
          <div className="al-pagination" aria-label="结果分页">
            <Button disabled={loading || pageIndex === 0} onClick={() => void changePage(0)}>首页</Button>
            <Button disabled={loading || pageIndex === 0} onClick={() => void changePage(pageIndex - 1)}>上一页</Button>
            <span>第 {loadedPageIndex + 1} / {totalPages} 页</span>
            <Button disabled={loading || pageIndex >= totalPages - 1} onClick={() => void changePage(pageIndex + 1)}>下一页</Button>
            <Button disabled={loading || pageIndex >= totalPages - 1} onClick={() => void changePage(totalPages - 1)}>末页</Button>
          </div>
        </div>

        <div className="al-detail">
          {!selected ? <div className="al-muted">选择左侧结果查看证据</div> : (
            <>
              <div className="al-viewer">
                <div ref={pageWrapRef} className="al-page-wrap" onScroll={resetPageViewportScroll} onWheel={onPageWheel} onMouseDown={onPageDown} onMouseMove={onPageMove} onMouseUp={onPageUp} onMouseLeave={onPageUp}>
                  <div className="al-viewer-overlays" onMouseDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
                    <div className="al-viewer-toolbar" aria-label="页面缩放工具">
                      <Button appearance="subtle" size="small" icon={<ZoomOutRegular />} aria-label="缩小页面" title="缩小页面" onClick={() => zoomBy(0.8)} />
                      <span className="al-zoom-value" aria-live="polite">{zoomPercent}%</span>
                      <Button appearance="subtle" size="small" icon={<ZoomInRegular />} aria-label="放大页面" title="放大页面" onClick={() => zoomBy(1.25)} />
                      <Button appearance="subtle" size="small" onClick={() => { fitWhenReadyRef.current = false; setZoom(1); setOffset({ x: 0, y: 0 }); }}>100%</Button>
                      <Button appearance="subtle" size="small" icon={<FullScreenMaximizeRegular />} onClick={fitPage}>适应窗口</Button>
                      <Button appearance="subtle" size="small" icon={<ArrowResetRegular />} onClick={recenterPage}>重新居中</Button>
                    </div>
                    <div className="al-page-orientation-toolbar" role="group" aria-label="页面展示方向">
                      {PAGE_ORIENTATION_OPTIONS.map((option) => (
                        <Button
                          key={option.value}
                          appearance={pageOrientation === option.value ? "primary" : "subtle"}
                          size="small"
                          icon={option.icon}
                          aria-label={option.label}
                          title={option.label}
                          aria-pressed={pageOrientation === option.value}
                          disabled={orientationSaving}
                          onClick={() => void changePageOrientation(option.value)}
                        />
                      ))}
                    </div>
                    {pageImageLoading && <div className="al-page-fidelity-status" role="status">正在加载原始清晰度…</div>}
                    {pageImage?.overscale_warning && (pageImage.source_kind === "demo" || zoom > 1) && (
                      <div className="al-page-fidelity-warning" role="status">{pageImage.overscale_warning}</div>
                    )}
                  </div>
                  {pageImageError && <div className="al-page-fidelity-error" role="alert">{pageImageError}</div>}
                  {pageImage && (
                    <div
                      className="al-page-positioner"
                      style={{
                        width: `${visualSize.width}px`,
                        height: `${visualSize.height}px`,
                        transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`,
                      }}
                    >
                      <div
                        className="al-page-canvas"
                        data-orientation={pageOrientation}
                        style={{
                          width: `${displayedSize.width}px`,
                          height: `${displayedSize.height}px`,
                          transform: `translate(-50%, -50%) rotate(${PAGE_ORIENTATION_DEGREES[pageOrientation]}deg)`,
                        }}
                      >
                        <img
                          src={assetUrl(taskId, pageImage.asset_relpath, pageImage.asset_version)}
                          alt="出处页"
                          draggable={false}
                        />
                        <div className="al-highlight" style={{ left: `${selected.normalized_x0 * 100}%`, top: `${selected.normalized_y0 * 100}%`, width: `${(selected.normalized_x1 - selected.normalized_x0) * 100}%`, height: `${(selected.normalized_y1 - selected.normalized_y0) * 100}%` }} />
                      </div>
                    </div>
                  )}
                </div>
              </div>
              <div className="al-detail-meta"><div>上下文：{selected.context_full}</div><div className="al-muted">OCR 置信度：{confidenceLabel(selected.ocr_confidence)}</div><div>系统判断：<strong>{verificationLabel(selected.verification_status)}</strong></div><div>人工结论：<strong>{decisionLabel(selected.review_decision)}</strong></div></div>
              <div className="al-review-command-bar">
                <div className="al-decision-actions" aria-label="校对判断">
                  <Button appearance={selected.review_decision === "confirmed" ? "primary" : "secondary"} aria-pressed={selected.review_decision === "confirmed"} onClick={() => void applyDecision("confirmed")}>确认命中 (A)</Button>
                  <Button appearance={selected.review_decision === "needs_review" ? "primary" : "secondary"} aria-pressed={selected.review_decision === "needs_review"} onClick={() => void applyDecision("needs_review")}>需要复核 (S)</Button>
                  <Button appearance={selected.review_decision === "rejected" ? "primary" : "secondary"} aria-pressed={selected.review_decision === "rejected"} onClick={() => void applyDecision("rejected")}>拒绝命中 (D)</Button>
                </div>
                <div className="al-navigation-actions" aria-label="结果导航">
                  <Button onClick={() => void goPrev()}>上一条 (K)</Button>
                  <Button appearance="primary" onClick={() => void goNext(true)}>下一条待处理 (N)</Button>
                  <Button onClick={() => void goNext()}>下一条 (J)</Button>
                </div>
              </div>
              <div className="al-review-note-panel">
                <Textarea ref={noteRef as any} value={note} onChange={(_, data) => updateNoteDraft(data.value)} placeholder="输入备注（停顿后自动保存）" aria-label="校对备注" className="al-note" />
                <div className="al-note-actions">
                  <span className="al-save-state" role="status">{saveState === "saving" ? "自动保存中…" : saveState === "saved" ? "已自动保存" : saveState === "error" ? "保存失败，草稿已保留" : note !== (selectedId ? savedNotesRef.current.get(noteDraftKey(taskId, selectedId)) ?? "" : "") ? "等待自动保存…" : ""}</span>
                  <Button onClick={() => void saveNote()}>立即保存 (Ctrl+Enter)</Button>
                </div>
              </div>
            </>
          )}
        </div>
        <aside className={summaryCollapsed ? "al-review-aside collapsed" : "al-review-aside"} aria-label="校对摘要与快捷键">
          <Button
            className="al-review-aside-toggle"
            appearance="subtle"
            icon={summaryCollapsed ? <PanelRightExpandRegular /> : <PanelRightContractRegular />}
            aria-label={summaryCollapsed ? "展开校对摘要" : "收起校对摘要"}
            title={summaryCollapsed ? "展开校对摘要" : "收起校对摘要"}
            onClick={() => setSummaryCollapsed((value) => !value)}
          />
          {summaryCollapsed ? (
            <div className="al-review-aside-collapsed-summary" aria-label={`已校对 ${reviewSummary.reviewed_count}，共 ${total} 条`}>
              <strong>{reviewSummary.unreviewed_count}</strong>
              <span>待处理</span>
              <div className="al-review-aside-progress"><span style={{ height: `${total ? reviewSummary.reviewed_count / total * 100 : 0}%` }} /></div>
            </div>
          ) : (
            <div className="al-review-aside-content">
              <section className="al-review-aside-card"><Text weight="semibold">校对摘要</Text><dl><div><dt>全部结果</dt><dd>{total}</dd></div><div><dt>已校对</dt><dd>{reviewSummary.reviewed_count}</dd></div><div><dt>未校对</dt><dd>{reviewSummary.unreviewed_count}</dd></div></dl><div className="al-review-mini-progress"><span style={{ width: `${total ? reviewSummary.reviewed_count / total * 100 : 0}%` }} /></div><Text className="al-muted">已确认 {reviewSummary.confirmed_count} · 待复核 {reviewSummary.needs_review_count} · 已拒绝 {reviewSummary.rejected_count}</Text></section>
              <section className="al-review-aside-card"><Text weight="semibold">当前状态</Text><Text>{scanComplete ? "扫描已完成" : `扫描仍在进行（${taskStatus || "状态未知"}）`}</Text><Text>{reviewComplete ? "全部结果已校对" : "仍有结果等待人工处理"}</Text></section>
              <section className="al-review-aside-card"><Text weight="semibold">快捷键</Text><div className="al-shortcut-list"><span><kbd>A</kbd> 确认命中</span><span><kbd>S</kbd> 需要复核</span><span><kbd>D</kbd> 拒绝命中</span><span><kbd>J</kbd>/<kbd>K</kbd> 下一条/上一条</span><span><kbd>N</kbd> 下一条未校对</span><span><kbd>F</kbd> 页面重新居中</span><span><kbd>Ctrl</kbd> + <kbd>Enter</kbd> 保存备注</span></div></section>
              <section className="al-review-aside-card al-review-local-note"><Text weight="semibold">本地处理</Text><Text className="al-muted">校对决定与备注将保存到当前任务数据库。</Text></section>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
