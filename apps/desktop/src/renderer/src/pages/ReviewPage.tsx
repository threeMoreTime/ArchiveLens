import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Input,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Text,
  Textarea,
} from "@fluentui/react-components";
import {
  ArrowDownRegular,
  ArrowLeftRegular,
  ArrowResetRegular,
  ArrowRightRegular,
  ArrowUpRegular,
  ChevronDownRegular,
  FullScreenMaximizeRegular,
  ZoomInRegular,
  ZoomOutRegular,
} from "@fluentui/react-icons";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  DEFAULT_REVIEW_HIGHLIGHT_STYLE,
  DEFAULT_REVIEW_PAGE_ORIENTATION,
  MAX_REVIEW_DECISION_CHANGES,
  type LayoutContext,
  type LayoutContextRect,
  type LayoutMode,
  type LayoutRebuildProgress,
  type ReviewHighlightSettingsResult,
  type ReviewHighlightStyle,
  type ReviewPageImageResult,
  type ReviewPageOrientation,
  type ReviewPageOrientations,
  type ReviewUpdateDecisionsResult,
} from "@shared/index";
import type { TaskSummary } from "../../../preload/api";
import { InlineFeedback, LoadingState } from "../components/feedback";
import { DiagnosticErrorNotice } from "../components/DiagnosticErrorNotice";
import { LayoutContextCanvas, layoutContextSubtitle } from "../components/LayoutContextCanvas";
import { highlightBackground } from "../components/ReviewHighlightSettings";
import { toDiagnosticIssue } from "../utils/diagnosticIssue";
import { taskDisplayName } from "../utils/presentation";
import {
  getReviewShortcutAction,
  readReviewShortcutBindings,
  reviewShortcutKeyLabel,
  type ConfigurableReviewShortcutAction,
} from "../utils/reviewShortcuts";
import {
  DEFAULT_REVIEW_LAYOUT,
  REVIEW_LAYOUT_PRESETS,
  readReviewDensity,
  readReviewLayout,
  readReviewPosition,
  resizeReviewLayout,
  storeReviewDensity,
  storeReviewLayout,
  storeReviewPosition,
  type ReviewDecision,
  type ReviewDensity,
  type ReviewLayoutRatios,
} from "../utils/reviewWorkbench";

const RESULT_CHUNK_SIZE = 100;
const NOTE_DRAFT_PREFIX = "archivelens.reviewDraft.";
const MAX_HISTORY_ENTRIES = 50;
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
  global_sequence: number;
  document_id: string;
  file_path: string;
  file_name: string;
  page_number: number;
  matched_text: string;
  character_variant: string | null;
  context_full: string;
  ocr_line_id?: string;
  layout_context?: LayoutContext | null;
  layout_context_text?: string;
  layout_context_version?: number;
  layout_context_status?: "pending" | "ready" | "uncertain" | "failed";
  layout_context_error?: string;
  ocr_confidence: number | null;
  verification_status: string;
  review_decision: ReviewDecision;
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

interface ChunkResult {
  offset: number;
  total: number;
  items: Occurrence[];
  reviewSummary: ReviewSummary;
  layoutRebuild: LayoutRebuildProgress;
}

interface DecisionChange {
  occurrenceId: string;
  sequence: number;
  before: ReviewDecision;
  after: ReviewDecision;
}

interface DecisionHistoryEntry {
  label: string;
  changes: DecisionChange[];
}

interface TaskDecisionHistory {
  undo: DecisionHistoryEntry[];
  redo: DecisionHistoryEntry[];
}

function persistedDecisionChanges(
  changes: DecisionChange[],
  result: ReviewUpdateDecisionsResult,
): DecisionChange[] {
  const previousById = new Map(result.items.map((item) => [item.occurrence_id, item.previous_decision]));
  return changes.map((change) => ({
    ...change,
    before: previousById.has(change.occurrenceId)
      ? previousById.get(change.occurrenceId)!
      : change.before,
  }));
}

const SESSION_DECISION_HISTORY = new Map<string, TaskDecisionHistory>();
const SESSION_PENDING_DECISION_OPERATIONS = new Map<string, string>();

const EMPTY_SUMMARY: ReviewSummary = {
  reviewed_count: 0,
  unreviewed_count: 0,
  confirmed_count: 0,
  needs_review_count: 0,
  rejected_count: 0,
};

const DETAIL_DRAWER_MEDIA_QUERY = "(max-width: 1180px)";
const DETAIL_DRAWER_FOCUSABLE = [
  "button:not([disabled]):not([tabindex='-1'])",
  "a[href]:not([tabindex='-1'])",
  "input:not([disabled]):not([tabindex='-1'])",
  "select:not([disabled]):not([tabindex='-1'])",
  "textarea:not([disabled]):not([tabindex='-1'])",
  "summary:not([tabindex='-1'])",
  "[tabindex]:not([tabindex='-1']):not([data-detail-focus-guard])",
].join(",");

function assetUrl(taskId: string, rel: string | null, version?: string) {
  if (!rel) return "";
  const query = version ? "?v=" + encodeURIComponent(version) : "";
  return "al-resource://" + taskId + "/" + rel.replace(/^\/+/, "") + query;
}

function errorMessage(error: unknown) {
  const raw = error instanceof Error ? error.message.trim() : "操作失败，请重试";
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^(?:(?:Error|EngineError):\s*)+/i, "")
    || "操作失败，请重试";
}

function confidenceLabel(value: number | null) {
  return typeof value === "number" ? `${Math.round(value * 100)}%` : "未提供置信度";
}

function verificationLabel(status: string) {
  const labels: Record<string, string> = {
    confirmed: "系统判断可信",
    needs_review: "系统建议人工复核",
    rejected: "系统判断不匹配",
  };
  return labels[status] ?? "系统状态未知";
}

function decisionLabel(decision: ReviewDecision) {
  const labels: Record<Exclude<ReviewDecision, null>, string> = {
    confirmed: "已确认",
    needs_review: "待复核",
    rejected: "已拒绝",
  };
  return decision ? labels[decision] : "未校对";
}

function sequenceLabel(sequence: number) {
  return "#" + String(sequence).padStart(4, "0");
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizedRect(rect: LayoutContextRect): LayoutContextRect {
  return {
    x0: clamp(Math.min(rect.x0, rect.x1), 0, 1),
    y0: clamp(Math.min(rect.y0, rect.y1), 0, 1),
    x1: clamp(Math.max(rect.x0, rect.x1), 0, 1),
    y1: clamp(Math.max(rect.y0, rect.y1), 0, 1),
  };
}

function noteDraftKey(taskId: string, occurrenceId: string) {
  return NOTE_DRAFT_PREFIX + taskId + ":" + occurrenceId;
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

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true'], [role='textbox']"));
}

export default function ReviewPage() {
  const { taskId = "" } = useParams();
  const nav = useNavigate();
  const [task, setTask] = useState<TaskSummary | null>(null);
  const [taskOptions, setTaskOptions] = useState<TaskSummary[]>([]);
  const [readyTaskId, setReadyTaskId] = useState("");
  const [items, setItems] = useState<Array<Occurrence | undefined>>([]);
  const itemsRef = useRef<Array<Occurrence | undefined>>([]);
  itemsRef.current = items;
  const [total, setTotal] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [variantFilter, setVariantFilter] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [reviewSummary, setReviewSummary] = useState<ReviewSummary>(EMPTY_SUMMARY);
  const [queryError, setQueryError] = useState("");
  const [actionError, setActionError] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [actionProgress, setActionProgress] = useState("");
  const [note, setNote] = useState("");
  const [noteExpanded, setNoteExpanded] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [pageImage, setPageImage] = useState<ReviewPageImageResult | null>(null);
  const [pageImageLoading, setPageImageLoading] = useState(false);
  const [pageImageError, setPageImageError] = useState("");
  const [layoutContext, setLayoutContext] = useState<LayoutContext | null>(null);
  const [layoutPreviewContext, setLayoutPreviewContext] = useState<LayoutContext | null>(null);
  const [layoutContextLoading, setLayoutContextLoading] = useState(false);
  const [layoutContextError, setLayoutContextError] = useState("");
  const [layoutRebuild, setLayoutRebuild] = useState<LayoutRebuildProgress | null>(null);
  const [layoutRebuildError, setLayoutRebuildError] = useState("");
  const [layoutRebuildKick, setLayoutRebuildKick] = useState(0);
  const [layoutCorrectionMode, setLayoutCorrectionMode] = useState(false);
  const [layoutDraftMode, setLayoutDraftMode] = useState<LayoutMode>("auto");
  const [layoutDraftBlock, setLayoutDraftBlock] = useState<LayoutContextRect | null>(null);
  const [layoutSaving, setLayoutSaving] = useState(false);
  const [pageOrientations, setPageOrientations] = useState<ReviewPageOrientations>({});
  const [orientationSaving, setOrientationSaving] = useState(false);
  const [highlightStyle, setHighlightStyle] = useState<ReviewHighlightStyle>(DEFAULT_REVIEW_HIGHLIGHT_STYLE);
  const [layout, setLayout] = useState<ReviewLayoutRatios>(() => readReviewLayout());
  const [density, setDensity] = useState<ReviewDensity>(() => readReviewDensity());
  const [imageFocused, setImageFocused] = useState(false);
  const [detailDrawerOpen, setDetailDrawerOpen] = useState(false);
  const [detailUsesDrawer, setDetailUsesDrawer] = useState(() => (
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(DETAIL_DRAWER_MEDIA_QUERY).matches
      : false
  ));
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [shortcutBindings] = useState(readReviewShortcutBindings);
  const [batchMode, setBatchMode] = useState(false);
  const [includeReviewedInBatch, setIncludeReviewedInBatch] = useState(false);
  const [selectedBatchIds, setSelectedBatchIds] = useState<Set<string>>(() => new Set());
  const [jumpInput, setJumpInput] = useState("");
  const [historyVersion, setHistoryVersion] = useState(0);
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const layoutBlockDragRef = useRef<{ x: number; y: number } | null>(null);
  const reviewBodyRef = useRef<HTMLDivElement | null>(null);
  const pageWrapRef = useRef<HTMLDivElement | null>(null);
  const resultScrollRef = useRef<HTMLDivElement | null>(null);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  const detailRef = useRef<HTMLElement | null>(null);
  const detailDrawerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const detailDrawerCloseRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const currentTaskIdRef = useRef(taskId);
  const selectedRef = useRef<{ taskId: string; id: string } | null>(null);
  const selectedPageKeyRef = useRef<string | null>(null);
  const noteDraftsRef = useRef(new Map<string, string>());
  const savedNotesRef = useRef(new Map<string, string>());
  const noteSaveQueuesRef = useRef(new Map<string, Promise<boolean>>());
  const noteSnapshotRef = useRef<{ taskId: string | null; id: string | null; value: string }>({ taskId: null, id: null, value: "" });
  const queryGenerationRef = useRef(0);
  const loadedChunkOffsetsRef = useRef(new Set<number>());
  const loadedChunkResultsRef = useRef(new Map<number, ChunkResult>());
  const chunkRequestsRef = useRef(new Map<number, Promise<ChunkResult | null>>());
  const loadingTokensRef = useRef(new Set<string>());
  const [, setLoadingVersion] = useState(0);
  const pendingScrollIndexRef = useRef<number | null>(null);
  const restoredTaskRef = useRef("");
  const batchAnchorIndexRef = useRef<number | null>(null);
  const pageImageRequestRef = useRef(0);
  const layoutContextRequestRef = useRef(0);
  const layoutRebuildGenerationRef = useRef(0);
  const fitWhenReadyRef = useRef(true);
  const persistedPageOrientationsRef = useRef<ReviewPageOrientations>({});
  const pageImageCacheRef = useRef(new Map<string, ReviewPageImageResult>());
  const pageImagePreloadRef = useRef(new Set<string>());
  const decisionHistoryRef = useRef(SESSION_DECISION_HISTORY);
  const decisionOperationRef = useRef(0);
  const reviewContextKey = [taskId, statusFilter, variantFilter, search].join("\u0000");
  const reviewContextRef = useRef(reviewContextKey);
  reviewContextRef.current = reviewContextKey;
  currentTaskIdRef.current = taskId;

  const selectedIndex = useMemo(
    () => items.findIndex((item) => item?.occurrence_id === selectedId),
    [items, selectedId],
  );
  const selected = selectedIndex >= 0 ? items[selectedIndex] ?? null : null;
  const displayedLayoutContext = layoutPreviewContext ?? layoutContext;
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
  const progressPercent = total ? Math.round(reviewSummary.reviewed_count / total * 100) : 0;
  const loading = loadingTokensRef.current.size > 0;
  const taskHistory = useMemo(() => {
    void historyVersion;
    return decisionHistoryRef.current.get(taskId) ?? { undo: [], redo: [] };
  }, [historyVersion, taskId]);

  const taskMenuItems = useMemo(() => {
    if (!task) return taskOptions;
    return taskOptions.some((item) => item.task_id === task.task_id) ? taskOptions : [task, ...taskOptions];
  }, [task, taskOptions]);

  const selectedBatchItems = useMemo(
    () => items.flatMap((item, index) => item && selectedBatchIds.has(item.occurrence_id) ? [{ item, index }] : []),
    [items, selectedBatchIds],
  );
  const batchRangeText = useMemo(() => {
    if (selectedBatchItems.length === 0) return "尚未选择结果";
    const sequences = selectedBatchItems.map(({ item }) => item.global_sequence).sort((a, b) => a - b);
    const first = sequences[0] ?? 0;
    const last = sequences[sequences.length - 1] ?? first;
    return first === last ? sequenceLabel(first) : sequenceLabel(first) + " 至 " + sequenceLabel(last);
  }, [selectedBatchItems]);

  useEffect(() => {
    storeReviewLayout(layout);
  }, [layout]);

  useEffect(() => {
    storeReviewDensity(density);
  }, [density]);

  // 记录当前选中结果的 occurrence ID（仅 ID，不写入 OCR 正文），供开发者页 AI 调试复用。
  useEffect(() => {
    if (!taskId || !selectedId) return;
    try {
      localStorage.setItem(`archivelens.lastReviewOccurrence.${taskId}`, selectedId);
    } catch {
      // 存储不可用时忽略；仅影响开发者页 AI 调试的默认选择。
    }
  }, [taskId, selectedId]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mediaQuery = window.matchMedia(DETAIL_DRAWER_MEDIA_QUERY);
    const updateDrawerMode = () => {
      setDetailUsesDrawer(mediaQuery.matches);
      if (!mediaQuery.matches) setDetailDrawerOpen(false);
    };
    updateDrawerMode();
    mediaQuery.addEventListener("change", updateDrawerMode);
    return () => mediaQuery.removeEventListener("change", updateDrawerMode);
  }, []);

  useEffect(() => {
    if (!detailRef.current) return;
    detailRef.current.inert = detailUsesDrawer && !detailDrawerOpen;
  }, [detailDrawerOpen, detailUsesDrawer]);

  useEffect(() => {
    if (!detailUsesDrawer || !detailDrawerOpen) return;
    const handleDrawerKeyboard = (event: KeyboardEvent) => {
      const detail = detailRef.current;
      if (!detail) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setDetailDrawerOpen(false);
        window.setTimeout(() => detailDrawerTriggerRef.current?.focus(), 0);
        return;
      }
    };
    window.addEventListener("keydown", handleDrawerKeyboard, true);
    return () => window.removeEventListener("keydown", handleDrawerKeyboard, true);
  }, [detailDrawerOpen, detailUsesDrawer]);

  useEffect(() => {
    if (actionBusy) return;
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [actionBusy, searchInput]);

  useEffect(() => {
    queryGenerationRef.current += 1;
    decisionOperationRef.current += 1;
    loadedChunkOffsetsRef.current.clear();
    loadedChunkResultsRef.current.clear();
    chunkRequestsRef.current.clear();
    loadingTokensRef.current.clear();
    setTask(null);
    setReadyTaskId("");
    setItems([]);
    setTotal(0);
    setSelectedId(null);
    setReviewSummary(EMPTY_SUMMARY);
    setStatusFilter("");
    setVariantFilter("");
    setSearchInput("");
    setSearch("");
    setQueryError("");
    setActionError("");
    setActionBusy(false);
    setActionProgress("");
    setBatchMode(false);
    setIncludeReviewedInBatch(false);
    setSelectedBatchIds(new Set());
    setDetailDrawerOpen(false);
    setImageFocused(false);
    layoutContextRequestRef.current += 1;
    layoutRebuildGenerationRef.current += 1;
    setLayoutContext(null);
    setLayoutPreviewContext(null);
    setLayoutContextLoading(false);
    setLayoutContextError("");
    setLayoutRebuild(null);
    setLayoutRebuildError("");
    setLayoutCorrectionMode(false);
    setLayoutDraftMode("auto");
    setLayoutDraftBlock(null);
    setLayoutSaving(false);
    setPageOrientations({});
    persistedPageOrientationsRef.current = {};
    pageImageCacheRef.current.clear();
    pageImagePreloadRef.current.clear();

    let active = true;
    void window.archiveLens.tasks.get(taskId).then((result: TaskSummary) => {
      if (!active) return;
      setTask(result);
      setReadyTaskId(taskId);
    }).catch((error: unknown) => {
      if (!active) return;
      setQueryError(errorMessage(error));
    });
    void window.archiveLens.tasks.list({ limit: 50, offset: 0 }).then((response: { items: TaskSummary[] }) => {
      if (active) setTaskOptions(response.items);
    }).catch(() => {
      if (active) setTaskOptions([]);
    });
    return () => { active = false; };
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
      setActionError("读取校对显示设置失败：" + errorMessage(error) + "。当前使用默认高亮且页面朝上。");
    });
    return () => { active = false; };
  }, [taskId]);

  const setLoadingToken = useCallback((token: string, active: boolean) => {
    if (active) loadingTokensRef.current.add(token);
    else loadingTokensRef.current.delete(token);
    setLoadingVersion((value) => value + 1);
  }, []);

  const loadChunk = useCallback((requestedOffset: number): Promise<ChunkResult | null> => {
    const offsetValue = Math.max(0, Math.floor(requestedOffset / RESULT_CHUNK_SIZE) * RESULT_CHUNK_SIZE);
    const existing = chunkRequestsRef.current.get(offsetValue);
    if (existing) return existing;
    const cached = loadedChunkResultsRef.current.get(offsetValue);
    if (cached) return Promise.resolve(cached);
    if (loadedChunkOffsetsRef.current.has(offsetValue)) return Promise.resolve(null);
    const generation = queryGenerationRef.current;
    const token = String(generation) + ":" + String(offsetValue);
    setLoadingToken(token, true);
    const request = window.archiveLens.results.query({
      task_id: taskId,
      limit: RESULT_CHUNK_SIZE,
      offset: offsetValue,
      status: statusFilter || null,
      character: variantFilter || null,
      search: search || null,
    }).then((response) => {
      if (generation !== queryGenerationRef.current) return null;
      const result: ChunkResult = {
        offset: response.offset,
        total: response.total,
        items: response.items as Occurrence[],
        reviewSummary: response.review_summary,
        layoutRebuild: response.layout_rebuild,
      };
      loadedChunkResultsRef.current.set(offsetValue, result);
      loadedChunkOffsetsRef.current.add(offsetValue);
      setTotal(response.total);
      setReviewSummary(response.review_summary);
      setLayoutRebuild(response.layout_rebuild);
      setItems((previous) => {
        const next = new Array<Occurrence | undefined>(response.total);
        const copyLength = Math.min(previous.length, response.total);
        for (let index = 0; index < copyLength; index += 1) next[index] = previous[index];
        result.items.forEach((item, index) => { next[result.offset + index] = item; });
        return next;
      });
      return result;
    }).catch((error: unknown) => {
      if (generation === queryGenerationRef.current) setQueryError(errorMessage(error));
      return null;
    }).finally(() => {
      if (chunkRequestsRef.current.get(offsetValue) === request) chunkRequestsRef.current.delete(offsetValue);
      setLoadingToken(token, false);
    });
    chunkRequestsRef.current.set(offsetValue, request);
    return request;
  }, [search, setLoadingToken, statusFilter, taskId, variantFilter]);

  const resetResults = useCallback(async (requestedIndex = 0, preferredId?: string): Promise<ChunkResult | null> => {
    queryGenerationRef.current += 1;
    loadedChunkOffsetsRef.current.clear();
    loadedChunkResultsRef.current.clear();
    chunkRequestsRef.current.clear();
    loadingTokensRef.current.clear();
    setLoadingVersion((value) => value + 1);
    setItems([]);
    setTotal(0);
    setSelectedId(null);
    setReviewSummary(EMPTY_SUMMARY);
    setQueryError("");
    setSelectedBatchIds(new Set());
    batchAnchorIndexRef.current = null;
    const initialOffset = Math.max(0, Math.floor(requestedIndex / RESULT_CHUNK_SIZE) * RESULT_CHUNK_SIZE);
    let result = await loadChunk(initialOffset);
    if (result && result.total > 0 && result.items.length === 0 && initialOffset > 0) {
      const lastOffset = Math.floor((result.total - 1) / RESULT_CHUNK_SIZE) * RESULT_CHUNK_SIZE;
      result = await loadChunk(lastOffset);
    }
    if (!result || result.total === 0) return result;
    const boundedIndex = Math.min(result.total - 1, Math.max(0, requestedIndex));
    const preferred = preferredId ? result.items.find((item) => item.occurrence_id === preferredId) : undefined;
    const candidate = preferred ?? result.items[boundedIndex - result.offset] ?? result.items[0];
    setSelectedId(candidate?.occurrence_id ?? null);
    const candidateIndex = candidate ? result.offset + result.items.indexOf(candidate) : boundedIndex;
    pendingScrollIndexRef.current = candidateIndex;
    return result;
  }, [loadChunk]);

  useEffect(() => {
    if (readyTaskId !== taskId) return;
    const restoringTask = restoredTaskRef.current !== taskId;
    restoredTaskRef.current = taskId;
    const restoreIndex = restoringTask && !statusFilter && !variantFilter && !search
      ? readReviewPosition(taskId)
      : 0;
    void resetResults(restoreIndex);
  }, [readyTaskId, resetResults, search, statusFilter, taskId, variantFilter]);

  const rowVirtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => resultScrollRef.current,
    estimateSize: () => density === "compact" ? 86 : 104,
    overscan: 8,
    getItemKey: (index) => items[index]?.occurrence_id ?? "placeholder-" + String(index),
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const virtualRangeKey = virtualRows.map((row) => row.index).join(",");

  useEffect(() => {
    const visibleRows = rowVirtualizer.getVirtualItems();
    if (readyTaskId !== taskId || visibleRows.length === 0) return;
    const offsets = new Set<number>();
    visibleRows.forEach((row) => {
      if (!itemsRef.current[row.index]) offsets.add(Math.floor(row.index / RESULT_CHUNK_SIZE) * RESULT_CHUNK_SIZE);
    });
    offsets.forEach((chunkOffset) => { void loadChunk(chunkOffset); });
  }, [loadChunk, readyTaskId, rowVirtualizer, taskId, virtualRangeKey]);

  useEffect(() => {
    const targetIndex = pendingScrollIndexRef.current;
    if (targetIndex === null || targetIndex !== selectedIndex || !items[targetIndex]) return;
    pendingScrollIndexRef.current = null;
    rowVirtualizer.scrollToIndex(targetIndex, { align: "center" });
  }, [items, rowVirtualizer, selectedIndex]);

  useEffect(() => {
    if (selectedIndex < 0) return;
    storeReviewPosition(taskId, selectedIndex);
  }, [selectedIndex, taskId]);

  const ensureItemAt = useCallback(async (index: number, seed?: ChunkResult | null): Promise<Occurrence | undefined> => {
    if (index < 0) return undefined;
    if ((seed && index >= seed.total) || (!seed && total > 0 && index >= total)) return undefined;
    if (seed && index >= seed.offset && index < seed.offset + seed.items.length) {
      return seed.items[index - seed.offset];
    }
    const cached = itemsRef.current[index];
    if (cached) return cached;
    const result = await loadChunk(index);
    return result?.items[index - (result?.offset ?? 0)] ?? itemsRef.current[index];
  }, [loadChunk, total]);

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
        if (selectedRef.current?.taskId === targetTaskId && selectedRef.current.id === occurrenceId) {
          setSaveState("error");
          setNoteExpanded(true);
        }
        if (targetTaskId === currentTaskIdRef.current) {
          setActionError("备注保存失败：" + errorMessage(error) + "。草稿已保留在本机；请重试保存后再离开当前结果。");
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
    const savedNotes = savedNotesRef.current;
    const occurrenceId = selected?.occurrence_id ?? null;
    selectedRef.current = occurrenceId ? { taskId, id: occurrenceId } : null;
    if (!occurrenceId) {
      noteSnapshotRef.current = { taskId: null, id: null, value: "" };
      setNote("");
      setNoteExpanded(false);
      setSaveState("idle");
      return;
    }
    const draftKey = noteDraftKey(taskId, occurrenceId);
    const persisted = selected?.review_note ?? "";
    if (!savedNotes.has(draftKey)) savedNotes.set(draftKey, persisted);
    const draft = noteDraftsRef.current.get(draftKey) ?? readStoredDraft(draftKey) ?? persisted;
    noteDraftsRef.current.set(draftKey, draft);
    noteSnapshotRef.current = { taskId, id: occurrenceId, value: draft };
    setNote(draft);
    setNoteExpanded(draft.trim().length > 0);
    setSaveState(savedNotes.get(draftKey) === draft ? "idle" : "saving");
    return () => {
      const snapshot = noteSnapshotRef.current;
      if (snapshot.taskId === taskId && snapshot.id === occurrenceId && savedNotes.get(draftKey) !== snapshot.value) {
        void persistNote(taskId, occurrenceId, snapshot.value);
      }
    };
  }, [persistNote, selected?.occurrence_id, selected?.review_note, taskId]);

  useEffect(() => {
    if (!selectedId || savedNotesRef.current.get(noteDraftKey(taskId, selectedId)) === note) return;
    const timer = window.setTimeout(() => { void persistNote(taskId, selectedId, note); }, 700);
    return () => window.clearTimeout(timer);
  }, [note, persistNote, selectedId, taskId]);

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
    const viewport = pageWrapRef.current;
    if (!viewport) return;
    const updateSize = () => setViewportSize({ width: viewport.clientWidth, height: viewport.clientHeight });
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [selectedId, imageFocused]);

  const selectedOccurrenceId = selected?.occurrence_id ?? null;
  const selectedPageKey = selected ? taskId + ":" + selected.document_id + ":" + String(selected.page_number) : null;

  const applyLayoutContext = useCallback((occurrenceId: string, context: LayoutContext) => {
    setItems((previous) => {
      const index = previous.findIndex((item) => item?.occurrence_id === occurrenceId);
      if (index < 0 || !previous[index]) return previous;
      const next = previous.slice();
      next[index] = {
        ...previous[index],
        context_full: context.plain_text,
        layout_context: context,
        layout_context_text: context.plain_text,
        layout_context_version: context.version,
        layout_context_status: context.status,
        layout_context_error: "",
      };
      return next;
    });
    loadedChunkResultsRef.current.forEach((chunk) => {
      const index = chunk.items.findIndex((item) => item.occurrence_id === occurrenceId);
      if (index < 0) return;
      chunk.items[index] = {
        ...chunk.items[index]!,
        context_full: context.plain_text,
        layout_context: context,
        layout_context_text: context.plain_text,
        layout_context_version: context.version,
        layout_context_status: context.status,
        layout_context_error: "",
      };
    });
  }, []);

  useEffect(() => {
    const requestId = ++layoutContextRequestRef.current;
    setLayoutPreviewContext(null);
    setLayoutCorrectionMode(false);
    setLayoutDraftBlock(null);
    setLayoutContextError("");
    if (!selectedOccurrenceId) {
      setLayoutContext(null);
      setLayoutContextLoading(false);
      return;
    }
    const cached = itemsRef.current.find((item) => item?.occurrence_id === selectedOccurrenceId)?.layout_context ?? null;
    setLayoutContext(cached);
    setLayoutDraftMode(
      cached?.effective_layout_mode
      ?? task?.review_preferences?.layout_mode
      ?? "auto",
    );
    setLayoutContextLoading(!cached);
    let active = true;
    void window.archiveLens.review.getLayoutContext({
      task_id: taskId,
      occurrence_id: selectedOccurrenceId,
    }).then((result) => {
      if (!active || requestId !== layoutContextRequestRef.current) return;
      setLayoutContext(result.context);
      setLayoutDraftMode(result.context.effective_layout_mode ?? task?.review_preferences?.layout_mode ?? "auto");
      setLayoutDraftBlock(result.context.has_page_override ? result.context.normalized_block_bbox : null);
      applyLayoutContext(selectedOccurrenceId, result.context);
    }).catch((error: unknown) => {
      if (!active || requestId !== layoutContextRequestRef.current) return;
      setLayoutContextError(errorMessage(error));
    }).finally(() => {
      if (active && requestId === layoutContextRequestRef.current) setLayoutContextLoading(false);
    });
    return () => { active = false; };
  }, [applyLayoutContext, selectedOccurrenceId, task?.review_preferences?.layout_mode, taskId]);

  useEffect(() => {
    if (readyTaskId !== taskId || !selectedOccurrenceId) return;
    const generation = ++layoutRebuildGenerationRef.current;
    let timer = 0;
    let active = true;
    const runBatch = async () => {
      try {
        const progress = await window.archiveLens.review.rebuildLayoutContexts({
          task_id: taskId,
          limit: 25,
          priority_occurrence_id: selectedOccurrenceId,
        });
        if (!active || generation !== layoutRebuildGenerationRef.current) return;
        setLayoutRebuild(progress);
        setLayoutRebuildError("");
        if (progress.remaining > 0) timer = window.setTimeout(() => { void runBatch(); }, 80);
      } catch (error) {
        if (!active || generation !== layoutRebuildGenerationRef.current) return;
        setLayoutRebuildError(errorMessage(error));
      }
    };
    timer = window.setTimeout(() => { void runBatch(); }, 500);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [layoutRebuildKick, readyTaskId, selectedOccurrenceId, taskId]);

  useEffect(() => {
    pageImageRequestRef.current += 1;
    setPageImageLoading(false);
    setPageImageError("");
    if (!selectedPageKey) {
      selectedPageKeyRef.current = null;
      setPageImage(null);
      setZoom(1);
      setOffset({ x: 0, y: 0 });
      return;
    }
    const samePage = selectedPageKeyRef.current === selectedPageKey;
    selectedPageKeyRef.current = selectedPageKey;
    setOffset({ x: 0, y: 0 });
    if (samePage) return;
    fitWhenReadyRef.current = true;
    setZoom(1);
    setPageImage(pageImageCacheRef.current.get(selectedPageKey) ?? null);
  }, [selectedPageKey]);

  const calculateFitZoom = useCallback((image: ReviewPageImageResult) => {
    const baseWidth = orientationSwapsAxes ? image.height_100_css : image.width_100_css;
    const baseHeight = orientationSwapsAxes ? image.width_100_css : image.height_100_css;
    return Math.min(
      1,
      Math.max(0.02, (viewportSize.width - 24) / baseWidth),
      Math.max(0.02, (viewportSize.height - 24) / baseHeight),
    );
  }, [orientationSwapsAxes, viewportSize.height, viewportSize.width]);

  useEffect(() => {
    if (!selectedOccurrenceId || !selectedPageKey || viewportSize.width <= 0 || viewportSize.height <= 0) return;
    const requestId = ++pageImageRequestRef.current;
    let active = true;
    const timer = window.setTimeout(() => {
      setPageImageLoading(true);
      setPageImageError("");
      const targetWidth = pageImage?.width_100_css ? pageImage.width_100_css * zoom : viewportSize.width;
      const targetHeight = pageImage?.height_100_css ? pageImage.height_100_css * zoom : viewportSize.height;
      void window.archiveLens.review.preparePageImage({
        task_id: taskId,
        occurrence_id: selectedOccurrenceId,
        target_css_width: Math.max(1, targetWidth),
        target_css_height: Math.max(1, targetHeight),
        device_pixel_ratio: Math.min(4, Math.max(0.5, window.devicePixelRatio || 1)),
      }).then((result: ReviewPageImageResult) => {
        if (!active || requestId !== pageImageRequestRef.current) return;
        pageImageCacheRef.current.set(selectedPageKey, result);
        setPageImage(result);
        if (fitWhenReadyRef.current) {
          fitWhenReadyRef.current = false;
          setZoom(calculateFitZoom(result));
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
    calculateFitZoom,
    pageImage?.height_100_css,
    pageImage?.width_100_css,
    selectedOccurrenceId,
    selectedPageKey,
    taskId,
    viewportSize.height,
    viewportSize.width,
    zoom,
  ]);

  useEffect(() => {
    if (!selected || selectedIndex < 0 || viewportSize.width <= 0 || viewportSize.height <= 0) return;
    let active = true;
    void ensureItemAt(selectedIndex + 1).then((next) => {
      if (!active || !next) return;
      const nextKey = taskId + ":" + next.document_id + ":" + String(next.page_number);
      if (nextKey === selectedPageKey || pageImageCacheRef.current.has(nextKey) || pageImagePreloadRef.current.has(nextKey)) return;
      pageImagePreloadRef.current.add(nextKey);
      void window.archiveLens.review.preparePageImage({
        task_id: taskId,
        occurrence_id: next.occurrence_id,
        target_css_width: Math.max(1, viewportSize.width),
        target_css_height: Math.max(1, viewportSize.height),
        device_pixel_ratio: Math.min(4, Math.max(0.5, window.devicePixelRatio || 1)),
      }).then((result: ReviewPageImageResult) => {
        pageImageCacheRef.current.set(nextKey, result);
      }).catch(() => {
        // Preloading is opportunistic; selecting the item will perform the visible request.
      }).finally(() => {
        pageImagePreloadRef.current.delete(nextKey);
      });
    });
    return () => { active = false; };
  }, [ensureItemAt, selected, selectedIndex, selectedPageKey, taskId, viewportSize.height, viewportSize.width]);

  const fitPage = useCallback(() => {
    if (!pageImage) {
      fitWhenReadyRef.current = true;
      return;
    }
    fitWhenReadyRef.current = false;
    setZoom(calculateFitZoom(pageImage));
    setOffset({ x: 0, y: 0 });
  }, [calculateFitZoom, pageImage]);

  const togglePageView = useCallback(() => {
    if (!pageImage) {
      fitWhenReadyRef.current = true;
      return;
    }
    const fitZoom = calculateFitZoom(pageImage);
    fitWhenReadyRef.current = false;
    setZoom(Math.abs(zoom - fitZoom) < 0.02 ? 1 : fitZoom);
    setOffset({ x: 0, y: 0 });
  }, [calculateFitZoom, pageImage, zoom]);

  const onPageWheel = (event: ReactWheelEvent) => {
    event.preventDefault();
    fitWhenReadyRef.current = false;
    setZoom((value) => Math.min(4, Math.max(0.02, value * (event.deltaY < 0 ? 1.12 : 0.88))));
  };
  const zoomBy = (factor: number) => {
    fitWhenReadyRef.current = false;
    setZoom((value) => Math.min(4, Math.max(0.02, value * factor)));
  };
  const recenterPage = () => setOffset({ x: 0, y: 0 });
  const onPageDown = (event: ReactMouseEvent) => {
    dragRef.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
  };
  const onPageMove = (event: ReactMouseEvent) => {
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
    fitWhenReadyRef.current = pageImage === null;
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
      setActionError("保存页面展示方向失败：" + errorMessage(error) + "。已恢复上次保存的方向。");
    } finally {
      if (currentTaskIdRef.current === targetTaskId) setOrientationSaving(false);
    }
  };

  const previewLayoutCorrection = async (mode: LayoutMode, block: LayoutContextRect | null) => {
    if (!selectedOccurrenceId || layoutSaving) return;
    const occurrenceId = selectedOccurrenceId;
    setLayoutDraftMode(mode);
    setLayoutDraftBlock(block);
    setLayoutSaving(true);
    setLayoutContextError("");
    try {
      const result = await window.archiveLens.review.previewLayoutContext({
        task_id: taskId,
        occurrence_id: occurrenceId,
        layout_mode: mode,
        ...(block ? { normalized_block_bbox: normalizedRect(block) } : {}),
      });
      if (selectedRef.current?.id !== occurrenceId || selectedRef.current.taskId !== taskId) return;
      setLayoutPreviewContext(result.context);
    } catch (error) {
      if (selectedRef.current?.id !== occurrenceId || selectedRef.current.taskId !== taskId) return;
      setLayoutContextError("预览失败：" + errorMessage(error));
    } finally {
      if (selectedRef.current?.id === occurrenceId && selectedRef.current.taskId === taskId) setLayoutSaving(false);
    }
  };

  const openLayoutCorrection = () => {
    if (!layoutContext) return;
    const mode = layoutContext.effective_layout_mode ?? task?.review_preferences?.layout_mode ?? "auto";
    setLayoutDraftMode(mode);
    setLayoutDraftBlock(layoutContext.has_page_override ? layoutContext.normalized_block_bbox : null);
    setLayoutPreviewContext(null);
    setLayoutContextError("");
    setLayoutCorrectionMode(true);
  };

  const cancelLayoutCorrection = () => {
    setLayoutCorrectionMode(false);
    setLayoutPreviewContext(null);
    setLayoutDraftBlock(null);
    setLayoutContextError("");
  };

  const saveLayoutOverride = async (clear = false) => {
    if (!selectedOccurrenceId || layoutSaving) return;
    const occurrenceId = selectedOccurrenceId;
    setLayoutSaving(true);
    setLayoutContextError("");
    try {
      const result = await window.archiveLens.review.updateLayoutOverride({
        task_id: taskId,
        occurrence_id: occurrenceId,
        ...(clear
          ? { clear: true }
          : {
              layout_mode: layoutDraftMode,
              ...(layoutDraftBlock ? { normalized_block_bbox: normalizedRect(layoutDraftBlock) } : {}),
            }),
      });
      if (selectedRef.current?.id !== occurrenceId || selectedRef.current.taskId !== taskId) return;
      setLayoutContext(result.context);
      setLayoutPreviewContext(null);
      setLayoutCorrectionMode(false);
      setLayoutDraftMode(result.context.effective_layout_mode ?? "auto");
      setLayoutDraftBlock(result.context.has_page_override ? result.context.normalized_block_bbox : null);
      setLayoutRebuild(result.progress);
      applyLayoutContext(occurrenceId, result.context);
      setLayoutRebuildKick((value) => value + 1);
    } catch (error) {
      if (selectedRef.current?.id !== occurrenceId || selectedRef.current.taskId !== taskId) return;
      setLayoutContextError("保存版面修正失败：" + errorMessage(error));
    } finally {
      if (selectedRef.current?.id === occurrenceId && selectedRef.current.taskId === taskId) setLayoutSaving(false);
    }
  };

  const sourcePointFromPointer = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): { x: number; y: number } => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const screenX = clamp((event.clientX - bounds.left) / Math.max(1, bounds.width), 0, 1);
    const screenY = clamp((event.clientY - bounds.top) / Math.max(1, bounds.height), 0, 1);
    if (pageOrientation === "right") return { x: screenY, y: 1 - screenX };
    if (pageOrientation === "down") return { x: 1 - screenX, y: 1 - screenY };
    if (pageOrientation === "left") return { x: 1 - screenY, y: screenX };
    return { x: screenX, y: screenY };
  };

  const onLayoutBlockPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!layoutCorrectionMode || event.button !== 0 || (event.target as Element).closest("button")) return;
    event.preventDefault();
    event.stopPropagation();
    const point = sourcePointFromPointer(event);
    layoutBlockDragRef.current = point;
    event.currentTarget.setPointerCapture(event.pointerId);
    setLayoutDraftBlock({ x0: point.x, y0: point.y, x1: point.x, y1: point.y });
  };

  const onLayoutBlockPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = layoutBlockDragRef.current;
    if (!start) return;
    event.preventDefault();
    const point = sourcePointFromPointer(event);
    setLayoutDraftBlock(normalizedRect({ x0: start.x, y0: start.y, x1: point.x, y1: point.y }));
  };

  const onLayoutBlockPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = layoutBlockDragRef.current;
    if (!start) return;
    event.preventDefault();
    event.stopPropagation();
    layoutBlockDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const point = sourcePointFromPointer(event);
    const block = normalizedRect({ x0: start.x, y0: start.y, x1: point.x, y1: point.y });
    if (block.x1 - block.x0 < 0.01 || block.y1 - block.y0 < 0.01) {
      setLayoutDraftBlock(null);
      return;
    }
    void previewLayoutCorrection(layoutDraftMode, block);
  };

  const selectOccurrence = useCallback(async (occurrenceId: string, index: number, focus = false) => {
    if (actionBusy || occurrenceId === selectedId) return;
    if (!(await flushCurrentNote())) return;
    setSelectedId(occurrenceId);
    setDetailDrawerOpen(false);
    pendingScrollIndexRef.current = index;
    if (focus) {
      rowVirtualizer.scrollToIndex(index, { align: "auto" });
      window.setTimeout(() => optionRefs.current.get(occurrenceId)?.focus(), 0);
    }
  }, [actionBusy, flushCurrentNote, rowVirtualizer, selectedId]);

  const selectNextFrom = useCallback(async (
    startIndex: number,
    pendingOnly: boolean,
    seed?: ChunkResult | null,
    focus = false,
  ) => {
    const upperBound = seed?.total ?? total;
    for (let index = Math.max(0, startIndex); index < upperBound; index += 1) {
      const item = await ensureItemAt(index, seed);
      if (!item || (pendingOnly && item.review_decision !== null)) continue;
      setSelectedId(item.occurrence_id);
      pendingScrollIndexRef.current = index;
      if (focus) window.setTimeout(() => optionRefs.current.get(item.occurrence_id)?.focus(), 0);
      return true;
    }
    return false;
  }, [ensureItemAt, total]);

  const goNext = useCallback(async (pendingOnly = false) => {
    if (loading || actionBusy || !(await flushCurrentNote())) return;
    const found = await selectNextFrom(Math.max(0, selectedIndex + 1), pendingOnly);
    if (!found) setActionError(pendingOnly ? "已到达最后一条未校对结果" : "已到达最后一条结果");
  }, [actionBusy, flushCurrentNote, loading, selectNextFrom, selectedIndex]);

  const goPrev = useCallback(async () => {
    if (loading || actionBusy || !(await flushCurrentNote())) return;
    for (let index = selectedIndex - 1; index >= 0; index -= 1) {
      const item = await ensureItemAt(index);
      if (!item) continue;
      setSelectedId(item.occurrence_id);
      pendingScrollIndexRef.current = index;
      return;
    }
    setActionError("已到达第一条结果");
  }, [actionBusy, ensureItemAt, flushCurrentNote, loading, selectedIndex]);

  const pushHistory = useCallback((entry: DecisionHistoryEntry) => {
    const history = decisionHistoryRef.current.get(taskId) ?? { undo: [], redo: [] };
    history.undo.push(entry);
    if (history.undo.length > MAX_HISTORY_ENTRIES) history.undo.shift();
    history.redo = [];
    decisionHistoryRef.current.set(taskId, history);
    setHistoryVersion((value) => value + 1);
  }, [taskId]);

  const runDecisionChanges = useCallback(async (
    changes: DecisionChange[],
    target: "before" | "after",
    label: string,
    operationContext: string,
  ): Promise<ReviewUpdateDecisionsResult | null> => {
    const actionable = changes.filter((change) => change.before !== change.after);
    if (actionable.length === 0) return null;
    const uiOperationId = ++decisionOperationRef.current;
    const requestChanges = actionable.map((change) => ({
      occurrence_id: change.occurrenceId,
      decision: change[target],
    }));
    const pendingKey = taskId + "\u0000" + JSON.stringify(requestChanges);
    const operationId = SESSION_PENDING_DECISION_OPERATIONS.get(pendingKey) ?? window.crypto.randomUUID();
    SESSION_PENDING_DECISION_OPERATIONS.set(pendingKey, operationId);
    if (SESSION_PENDING_DECISION_OPERATIONS.size > MAX_HISTORY_ENTRIES) {
      const oldest = Array.from(SESSION_PENDING_DECISION_OPERATIONS.keys())[0];
      if (typeof oldest === "string") SESSION_PENDING_DECISION_OPERATIONS.delete(oldest);
    }
    setActionBusy(true);
    setActionError("");
    try {
      setActionProgress(actionable.length > 1 ? "正在原子保存 " + String(actionable.length) + " 条" : "正在保存");
      const request = {
        task_id: taskId,
        operation_id: operationId,
        changes: requestChanges,
      };
      let result: ReviewUpdateDecisionsResult;
      try {
        result = await window.archiveLens.review.updateDecisions(request);
      } catch {
        setActionProgress("正在确认本次保存结果");
        result = await window.archiveLens.review.updateDecisions(request);
      }
      const requestedById = new Map(actionable.map((change) => [change.occurrenceId, change[target]]));
      const returnedIds = new Set(result.items.map((item) => item.occurrence_id));
      const responseMatchesRequest = result.task_id === taskId
        && result.operation_id === operationId
        && result.items.length === actionable.length
        && returnedIds.size === actionable.length
        && result.items.every((item) => (
          requestedById.has(item.occurrence_id)
          && requestedById.get(item.occurrence_id) === item.decision
      ));
      if (!responseMatchesRequest) throw new Error("引擎返回的校对结果与请求不一致");
      SESSION_PENDING_DECISION_OPERATIONS.delete(pendingKey);
      return result;
    } catch (error) {
      if (reviewContextRef.current === operationContext) {
        setActionError(label + "结果尚未确认：" + errorMessage(error) + "。再次执行同一操作会安全确认原请求。");
      }
      return null;
    } finally {
      if (decisionOperationRef.current === uiOperationId) {
        setActionBusy(false);
        setActionProgress("");
      }
    }
  }, [taskId]);

  const applyDecision = useCallback(async (decision: Exclude<ReviewDecision, null>) => {
    if (!selected || actionBusy || selected.review_decision === decision) return;
    const operationContext = reviewContextRef.current;
    if (!(await flushCurrentNote()) || reviewContextRef.current !== operationContext) return;
    const anchorIndex = selectedIndex;
    const changes: DecisionChange[] = [{
      occurrenceId: selected.occurrence_id,
      sequence: selected.global_sequence,
      before: selected.review_decision,
      after: decision,
    }];
    const result = await runDecisionChanges(changes, "after", "保存校对状态", operationContext);
    if (!result) return;
    const persistedChanges = persistedDecisionChanges(changes, result);
    const previousDecision = persistedChanges[0] ? persistedChanges[0].before : selected.review_decision;
    if (previousDecision !== decision) {
      pushHistory({ label: sequenceLabel(selected.global_sequence) + " " + decisionLabel(decision), changes: persistedChanges });
    }
    if (reviewContextRef.current !== operationContext) return;
    const shouldAdvance = previousDecision === null && previousDecision !== decision;
    const seed = await resetResults(anchorIndex, shouldAdvance ? undefined : selected.occurrence_id);
    if (shouldAdvance && statusFilter !== "unreviewed") {
      const found = await selectNextFrom(anchorIndex + 1, true, seed);
      if (!found && seed?.total) {
        const fallback = await ensureItemAt(Math.min(anchorIndex, seed.total - 1), seed);
        setSelectedId(fallback?.occurrence_id ?? null);
      }
    }
  }, [
    actionBusy,
    ensureItemAt,
    flushCurrentNote,
    pushHistory,
    resetResults,
    runDecisionChanges,
    selectNextFrom,
    selected,
    selectedIndex,
    statusFilter,
  ]);

  const applyBatchDecision = async (decision: Exclude<ReviewDecision, null>) => {
    if (selectedBatchItems.length === 0 || actionBusy) return;
    if (selectedBatchItems.length > MAX_REVIEW_DECISION_CHANGES) {
      setActionError("单次批量审核最多处理 " + String(MAX_REVIEW_DECISION_CHANGES) + " 条");
      return;
    }
    const operationContext = reviewContextRef.current;
    if (!(await flushCurrentNote()) || reviewContextRef.current !== operationContext) return;
    const changes = selectedBatchItems
      .map(({ item }) => ({
        occurrenceId: item.occurrence_id,
        sequence: item.global_sequence,
        before: item.review_decision,
        after: decision,
      }))
      .filter((change) => change.before !== decision);
    if (changes.length === 0) {
      setActionError("所选结果已经是“" + decisionLabel(decision) + "”状态");
      return;
    }
    const anchorIndex = Math.min(...selectedBatchItems.map(({ index }) => index));
    const result = await runDecisionChanges(changes, "after", "批量审核", operationContext);
    if (!result) return;
    const persistedChanges = persistedDecisionChanges(changes, result)
      .filter((change) => change.before !== change.after);
    if (persistedChanges.length > 0) {
      pushHistory({
        label: "批量" + decisionLabel(decision) + " " + String(persistedChanges.length) + " 条",
        changes: persistedChanges,
      });
    }
    if (reviewContextRef.current !== operationContext) return;
    setSelectedBatchIds(new Set());
    setBatchMode(false);
    await resetResults(anchorIndex);
  };

  const performHistory = useCallback(async (direction: "undo" | "redo") => {
    if (actionBusy) return;
    const operationContext = reviewContextRef.current;
    if (!(await flushCurrentNote()) || reviewContextRef.current !== operationContext) return;
    const history = decisionHistoryRef.current.get(taskId);
    const source = direction === "undo" ? history?.undo : history?.redo;
    const entry = source?.[source.length - 1];
    if (!history || !source || !entry) return;
    const anchorIndex = Math.max(0, itemsRef.current.findIndex((item) => item?.occurrence_id === entry.changes[0]?.occurrenceId));
    const result = await runDecisionChanges(
      entry.changes,
      direction === "undo" ? "before" : "after",
      direction === "undo" ? "撤销" : "重做",
      operationContext,
    );
    if (!result) return;
    source.pop();
    if (direction === "undo") history.redo.push(entry);
    else history.undo.push(entry);
    setHistoryVersion((value) => value + 1);
    if (reviewContextRef.current !== operationContext) return;
    await resetResults(anchorIndex);
  }, [actionBusy, flushCurrentNote, resetResults, runDecisionChanges, taskId]);

  const saveNote = useCallback(async () => {
    if (!selectedId) return;
    setActionError("");
    await persistNote(taskId, selectedId, note);
  }, [note, persistNote, selectedId, taskId]);

  const updateNoteDraft = (value: string) => {
    setNote(value);
    setNoteExpanded(true);
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

  const toggleBatchItem = async (index: number, item: Occurrence, range: boolean) => {
    if (!includeReviewedInBatch && item.review_decision !== null) {
      setActionError("已审核结果默认不加入批量选择；如需覆盖，请先启用“包含已审核”。");
      return;
    }
    if (range && batchAnchorIndexRef.current !== null) {
      const start = Math.min(batchAnchorIndexRef.current, index);
      const end = Math.max(batchAnchorIndexRef.current, index);
      const chunks = new Map<number, ChunkResult | null>();
      const next = new Set(selectedBatchIds);
      let reachedLimit = false;
      for (let targetIndex = start; targetIndex <= end; targetIndex += 1) {
        let target = itemsRef.current[targetIndex];
        if (!target) {
          const chunkOffset = Math.floor(targetIndex / RESULT_CHUNK_SIZE) * RESULT_CHUNK_SIZE;
          let chunk = chunks.get(chunkOffset);
          if (chunk === undefined) {
            chunk = await loadChunk(chunkOffset);
            chunks.set(chunkOffset, chunk);
          }
          target = chunk?.items[targetIndex - chunkOffset] ?? itemsRef.current[targetIndex];
        }
        if (target && (includeReviewedInBatch || target.review_decision === null)) {
          if (!next.has(target.occurrence_id) && next.size >= MAX_REVIEW_DECISION_CHANGES) {
            reachedLimit = true;
            break;
          }
          next.add(target.occurrence_id);
        }
      }
      setSelectedBatchIds(next);
      if (reachedLimit) {
        setActionError("已达到单次批量审核上限 " + String(MAX_REVIEW_DECISION_CHANGES) + " 条");
      }
      return;
    }
    if (!selectedBatchIds.has(item.occurrence_id) && selectedBatchIds.size >= MAX_REVIEW_DECISION_CHANGES) {
      setActionError("已达到单次批量审核上限 " + String(MAX_REVIEW_DECISION_CHANGES) + " 条");
      return;
    }
    setSelectedBatchIds((current) => {
      const next = new Set(current);
      if (next.has(item.occurrence_id)) next.delete(item.occurrence_id);
      else next.add(item.occurrence_id);
      return next;
    });
    batchAnchorIndexRef.current = index;
  };

  const handleResultClick = (event: ReactMouseEvent, index: number, item: Occurrence) => {
    const multi = batchMode || event.ctrlKey || event.metaKey || event.shiftKey;
    if (multi) {
      setBatchMode(true);
      void toggleBatchItem(index, item, event.shiftKey);
      return;
    }
    void selectOccurrence(item.occurrence_id, index);
  };

  const handleResultKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number, item: Occurrence) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? Math.max(0, total - 1)
          : Math.max(0, Math.min(total - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
      void ensureItemAt(nextIndex).then((next) => {
        if (next) void selectOccurrence(next.occurrence_id, nextIndex, true);
      });
      return;
    }
    if ((event.key === " " || event.key === "Enter") && batchMode) {
      event.preventDefault();
      void toggleBatchItem(index, item, event.shiftKey);
    }
  };

  const changeIncludeReviewed = (checked: boolean) => {
    setIncludeReviewedInBatch(checked);
    if (!checked) {
      setSelectedBatchIds((current) => {
        const next = new Set(current);
        itemsRef.current.forEach((item) => {
          if (item && item.review_decision !== null) next.delete(item.occurrence_id);
        });
        return next;
      });
    }
  };

  const jumpToPosition = async () => {
    const position = Number(jumpInput);
    if (!Number.isInteger(position) || position < 1 || position > total) {
      setActionError("请输入 1 至 " + String(Math.max(1, total)) + " 之间的位置");
      return;
    }
    if (!(await flushCurrentNote())) return;
    const index = position - 1;
    const item = await ensureItemAt(index);
    if (!item) {
      setActionError("无法加载指定位置，请重试");
      return;
    }
    setSelectedId(item.occurrence_id);
    pendingScrollIndexRef.current = index;
    setJumpInput("");
  };

  const switchTask = async (nextTaskId: string) => {
    if (actionBusy || nextTaskId === taskId || !(await flushCurrentNote())) return;
    nav("/review/" + encodeURIComponent(nextTaskId));
  };

  const goToExport = async () => {
    if (!actionBusy && await flushCurrentNote()) nav("/export/" + encodeURIComponent(taskId));
  };

  const startResize = (divider: 0 | 1, event: ReactPointerEvent<HTMLDivElement>) => {
    const body = reviewBodyRef.current;
    if (!body) return;
    event.preventDefault();
    const startX = event.clientX;
    const startLayout = layout;
    const width = Math.max(1, body.getBoundingClientRect().width);
    const move = (moveEvent: PointerEvent) => {
      const deltaPercent = (moveEvent.clientX - startX) / width * 100;
      setLayout(resizeReviewLayout(startLayout, divider, deltaPercent));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const resizeByKeyboard = (divider: 0 | 1, event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setLayout((current) => resizeReviewLayout(current, divider, event.key === "ArrowRight" ? 2 : -2));
  };

  const openDetailDrawer = () => {
    setDetailDrawerOpen(true);
    window.setTimeout(() => detailDrawerCloseRef.current?.focus(), 0);
  };

  const focusDetailDrawerEdge = (edge: "first" | "last") => {
    const detail = detailRef.current;
    if (!detail) return;
    const focusable = Array.from(detail.querySelectorAll<HTMLElement>(DETAIL_DRAWER_FOCUSABLE))
      .filter((element) => element.getClientRects().length > 0 && element.getAttribute("aria-hidden") !== "true");
    const target = edge === "first" ? focusable[0] : focusable[focusable.length - 1];
    (target ?? detail).focus();
  };

  const closeDetailDrawer = () => {
    setDetailDrawerOpen(false);
    if (detailUsesDrawer) window.setTimeout(() => detailDrawerTriggerRef.current?.focus(), 0);
  };

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.ctrlKey && !event.altKey && !event.metaKey && !isEditableElement(event.target)) {
        const key = event.key.toLowerCase();
        if (key === "z") {
          event.preventDefault();
          void performHistory(event.shiftKey ? "redo" : "undo");
          return;
        }
        if (key === "y") {
          event.preventDefault();
          void performHistory("redo");
          return;
        }
      }
      if (document.activeElement === noteRef.current) {
        if (event.ctrlKey && event.key === "Enter") {
          event.preventDefault();
          void saveNote();
        }
        return;
      }
      const action = getReviewShortcutAction(event, shortcutBindings);
      if (!action) return;
      if (action === "toggle_view" && event.target instanceof Element && event.target.closest("button, [role='option']")) return;
      event.preventDefault();
      if (action === "confirm") void applyDecision("confirmed");
      else if (action === "needs_review") void applyDecision("needs_review");
      else if (action === "reject") void applyDecision("rejected");
      else if (action === "next") void goNext();
      else if (action === "previous") void goPrev();
      else if (action === "next_pending") void goNext(true);
      else if (action === "reset_view") recenterPage();
      else if (action === "toggle_view") togglePageView();
      else if (action === "focus_image") setImageFocused((value) => !value);
      else if (action === "toggle_note") {
        setNoteExpanded(true);
        window.setTimeout(() => noteRef.current?.focus(), 0);
      } else if (action === "shortcut_help") setShortcutsOpen(true);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [applyDecision, goNext, goPrev, performHistory, saveNote, shortcutBindings, togglePageView]);

  const shortcutLabel = (action: ConfigurableReviewShortcutAction) => (
    reviewShortcutKeyLabel(shortcutBindings[action])
  );

  const saveStateLabel = actionBusy
    ? actionProgress || "正在保存结论"
    : saveState === "saving"
      ? "备注保存中"
      : saveState === "saved"
        ? "已保存"
        : saveState === "error"
          ? "保存失败"
          : "本地保存";

  return (
    <div
      className={"al-review al-review-density-" + density + (imageFocused ? " image-focused" : "") + (batchMode ? " batch-mode" : "")}
      style={{
        "--al-review-highlight": highlightBackground(highlightStyle),
        "--al-image-pane": String(layout.image) + "%",
        "--al-list-pane": String(layout.list) + "%",
        "--al-detail-pane": String(layout.detail) + "%",
      } as CSSProperties}
    >
      <header className="al-review-taskbar">
        <div className="al-review-task-identity">
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Button appearance="subtle" size="small" className="al-review-task-switch" title="切换审核任务" icon={<ChevronDownRegular />} iconPosition="after" disabled={actionBusy}>
                <span>{task ? taskDisplayName(task) : "正在读取任务"}</span>
              </Button>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                {taskMenuItems.map((item) => (
                  <MenuItem key={item.task_id} disabled={actionBusy || item.task_id === taskId} onClick={() => void switchTask(item.task_id)}>
                    {taskDisplayName(item)}
                  </MenuItem>
                ))}
              </MenuList>
            </MenuPopover>
          </Menu>
          <span className="al-review-query" title={task?.search_text ?? ""}>检索：{task?.search_text || "未提供"}</span>
        </div>
        <div className="al-review-progress-summary" role="status" aria-label={"已审核 " + String(reviewSummary.reviewed_count) + "，共 " + String(total) + " 条"}>
          <div>
            <strong>{reviewSummary.reviewed_count} / {total}</strong>
            <span>已审核 · {reviewSummary.unreviewed_count} 待处理</span>
          </div>
          <div className="al-review-progress-track" aria-hidden="true"><span style={{ width: String(progressPercent) + "%" }} /></div>
        </div>
        <div className="al-review-task-actions">
          <span className={"al-review-save-indicator " + (saveState === "error" ? "error" : "")} aria-live="polite">{saveStateLabel}</span>
          <Button size="small" appearance="subtle" disabled={taskHistory.undo.length === 0 || actionBusy} onClick={() => void performHistory("undo")} title="撤销 Ctrl+Z">撤销</Button>
          <Button size="small" appearance="subtle" disabled={taskHistory.redo.length === 0 || actionBusy} onClick={() => void performHistory("redo")} title="重做 Ctrl+Shift+Z">重做</Button>
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Button size="small" appearance="subtle">布局</Button>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem onClick={() => setLayout(REVIEW_LAYOUT_PRESETS.balanced)}>均衡布局</MenuItem>
                <MenuItem onClick={() => setLayout(REVIEW_LAYOUT_PRESETS.image)}>图像优先</MenuItem>
                <MenuItem onClick={() => setLayout(REVIEW_LAYOUT_PRESETS.detail)}>详情优先</MenuItem>
                <MenuItem onClick={() => setLayout(DEFAULT_REVIEW_LAYOUT)}>重置布局</MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
          <Button size="small" appearance="subtle" onClick={() => setDensity((value) => value === "compact" ? "comfortable" : "compact")} title="切换结果列表密度">
            {density === "compact" ? "紧凑" : "舒适"}
          </Button>
          <Button size="small" appearance={imageFocused ? "primary" : "subtle"} onClick={() => setImageFocused((value) => !value)} title={`图像专注模式 ${shortcutLabel("focus_image")}`}>
            {imageFocused ? "退出专注" : "图像专注"}
          </Button>
          <Button ref={detailDrawerTriggerRef} size="small" appearance="subtle" className="al-detail-drawer-toggle" onClick={openDetailDrawer}>查看详情</Button>
          <Button size="small" appearance="subtle" onClick={() => setShortcutsOpen(true)} title="快捷键 ?">快捷键</Button>
          <Button size="small" appearance="primary" disabled={actionBusy} onClick={() => void goToExport()}>导出</Button>
        </div>
      </header>

      {queryError && <InlineFeedback>{queryError.startsWith("查询失败") ? queryError : "查询失败：" + queryError}</InlineFeedback>}
      {actionError && <InlineFeedback>{actionError}</InlineFeedback>}

      {batchMode && (
        <section className="al-review-batchbar" aria-label="批量审核">
          <div>
            <strong>已选 {selectedBatchIds.size} 条</strong>
            <span>{batchRangeText}</span>
          </div>
          <Checkbox
            checked={includeReviewedInBatch}
            label="包含已审核"
            onChange={(_, data) => changeIncludeReviewed(Boolean(data.checked))}
          />
          <div className="al-review-batch-actions">
            <Button size="small" disabled={selectedBatchIds.size === 0 || actionBusy} onClick={() => void applyBatchDecision("confirmed")}>批量确认</Button>
            <Button size="small" disabled={selectedBatchIds.size === 0 || actionBusy} onClick={() => void applyBatchDecision("needs_review")}>批量待复核</Button>
            <Button size="small" disabled={selectedBatchIds.size === 0 || actionBusy} onClick={() => void applyBatchDecision("rejected")}>批量拒绝</Button>
            <Button size="small" appearance="subtle" onClick={() => setSelectedBatchIds(new Set())}>清除选择</Button>
            <Button size="small" appearance="subtle" onClick={() => { setBatchMode(false); setSelectedBatchIds(new Set()); }}>退出批量</Button>
          </div>
        </section>
      )}

      <div ref={reviewBodyRef} className="al-review-body">
        <section className="al-review-image-pane" aria-label="原文件页面">
          {!selected ? <div className="al-review-pane-empty al-muted">从结果队列选择一条记录查看原文件页面</div> : (
            <div className="al-viewer">
              <div ref={pageWrapRef} className="al-page-wrap" onScroll={resetPageViewportScroll} onWheel={onPageWheel} onMouseDown={onPageDown} onMouseMove={onPageMove} onMouseUp={onPageUp} onMouseLeave={onPageUp}>
                <div className="al-viewer-overlays" onMouseDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
                  <div className="al-viewer-toolbar" aria-label="页面缩放工具">
                    <span className="al-page-evidence-sequence">当前 {sequenceLabel(selected.global_sequence)}</span>
                    <Button appearance="subtle" size="small" icon={<ZoomOutRegular />} aria-label="缩小页面" title="缩小页面" onClick={() => zoomBy(0.8)} />
                    <span className="al-zoom-value" aria-live="polite">{zoomPercent}%</span>
                    <Button appearance="subtle" size="small" icon={<ZoomInRegular />} aria-label="放大页面" title="放大页面" onClick={() => zoomBy(1.25)} />
                    <Button appearance="subtle" size="small" title={`原始比例 ${shortcutLabel("toggle_view")}`} onClick={() => { fitWhenReadyRef.current = false; setZoom(1); setOffset({ x: 0, y: 0 }); }}>原始比例</Button>
                    <Button appearance="subtle" size="small" icon={<FullScreenMaximizeRegular />} title={`适应页面 ${shortcutLabel("toggle_view")}`} onClick={fitPage}>适应页面</Button>
                    <Button appearance="subtle" size="small" icon={<ArrowResetRegular />} title={`重新居中 ${shortcutLabel("reset_view")}`} onClick={recenterPage}>重新居中</Button>
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
                      width: String(visualSize.width) + "px",
                      height: String(visualSize.height) + "px",
                      transform: "translate(calc(-50% + " + String(offset.x) + "px), calc(-50% + " + String(offset.y) + "px))",
                    }}
                  >
                    <div
                      className="al-page-canvas"
                      data-orientation={pageOrientation}
                      style={{
                        width: String(displayedSize.width) + "px",
                        height: String(displayedSize.height) + "px",
                        transform: "translate(-50%, -50%) rotate(" + String(PAGE_ORIENTATION_DEGREES[pageOrientation]) + "deg)",
                      }}
                    >
                      <img
                        src={assetUrl(taskId, pageImage.asset_relpath, pageImage.asset_version)}
                        alt="出处页"
                        draggable={false}
                      />
                      <div className="al-highlight" style={{ left: String(selected.normalized_x0 * 100) + "%", top: String(selected.normalized_y0 * 100) + "%", width: String((selected.normalized_x1 - selected.normalized_x0) * 100) + "%", height: String((selected.normalized_y1 - selected.normalized_y0) * 100) + "%" }} />
                      {layoutCorrectionMode && (
                        <div
                          className="al-layout-correction-surface"
                          role="group"
                          aria-label="在出处页选择 OCR 版块"
                          onPointerDown={onLayoutBlockPointerDown}
                          onPointerMove={onLayoutBlockPointerMove}
                          onPointerUp={onLayoutBlockPointerUp}
                          onPointerCancel={onLayoutBlockPointerUp}
                        >
                          {(layoutContext?.candidate_blocks ?? []).map((block) => (
                            <button
                              type="button"
                              key={block.id}
                              className={`al-layout-candidate-block${block.contains_target ? " contains-target" : ""}`}
                              style={{
                                left: String(block.normalized_bbox.x0 * 100) + "%",
                                top: String(block.normalized_bbox.y0 * 100) + "%",
                                width: String((block.normalized_bbox.x1 - block.normalized_bbox.x0) * 100) + "%",
                                height: String((block.normalized_bbox.y1 - block.normalized_bbox.y0) * 100) + "%",
                              }}
                              aria-label={`候选版块，${block.line_count} ${block.orientation === "vertical" ? "列" : "行"}`}
                              title="选择此候选版块并在右侧预览"
                              onPointerDown={(event) => event.stopPropagation()}
                              onClick={() => void previewLayoutCorrection(layoutDraftMode, block.normalized_bbox)}
                            />
                          ))}
                          {layoutDraftBlock && (
                            <span
                              className="al-layout-draft-block"
                              style={{
                                left: String(layoutDraftBlock.x0 * 100) + "%",
                                top: String(layoutDraftBlock.y0 * 100) + "%",
                                width: String(Math.max(0, layoutDraftBlock.x1 - layoutDraftBlock.x0) * 100) + "%",
                                height: String(Math.max(0, layoutDraftBlock.y1 - layoutDraftBlock.y0) * 100) + "%",
                              }}
                            />
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </section>

        <div
          className="al-review-resizer"
          role="separator"
          tabIndex={0}
          aria-label="调整图像与结果列表宽度"
          aria-orientation="vertical"
          onPointerDown={(event) => startResize(0, event)}
          onKeyDown={(event) => resizeByKeyboard(0, event)}
        />

        <div className="al-result-list" aria-busy={loading}>
          <div className="al-result-filters">
            <Input className="al-review-search" aria-label="搜索结果上下文" placeholder="搜索 OCR 上下文" value={searchInput} disabled={actionBusy} onChange={(_, data) => setSearchInput(data.value)} />
            <div className="al-review-filter-row">
              <select value={statusFilter} aria-label="校对状态筛选" disabled={actionBusy} onChange={(event) => setStatusFilter(event.target.value)}>
                <option value="">全部状态</option>
                <option value="unreviewed">未校对</option>
                <option value="confirmed">已确认</option>
                <option value="needs_review">待复核</option>
                <option value="rejected">已拒绝</option>
              </select>
              {task?.search_mode === "legacy_fixed_pair" && (
                <select value={variantFilter} aria-label="历史字符筛选" disabled={actionBusy} onChange={(event) => setVariantFilter(event.target.value)}>
                  <option value="">全部字形</option>
                  <option value="simplified">约</option>
                  <option value="traditional">約</option>
                </select>
              )}
            </div>
            <div className="al-review-list-meta">
              <Text className="al-muted">{total === 0 ? "无结果" : loading ? "结果加载中…（共 " + String(total) + " 条）" : "共 " + String(total) + " 条结果"}</Text>
              <Button size="small" appearance={batchMode ? "primary" : "subtle"} disabled={actionBusy} onClick={() => { setBatchMode((value) => !value); setSelectedBatchIds(new Set()); }}>
                {batchMode ? "批量选择中" : "批量选择"}
              </Button>
            </div>
            <div className="al-review-jump">
              <Input
                value={jumpInput}
                disabled={actionBusy}
                aria-label="跳转到筛选结果位置"
                placeholder="位置"
                onChange={(_, data) => setJumpInput(data.value.replace(/[^\d]/g, ""))}
                onKeyDown={(event) => { if (event.key === "Enter") void jumpToPosition(); }}
              />
              <Button size="small" disabled={actionBusy} onClick={() => void jumpToPosition()}>跳转</Button>
            </div>
          </div>
          <div
            ref={resultScrollRef}
            className="al-result-scroll"
            role="listbox"
            aria-label="校对结果"
            aria-multiselectable={batchMode}
          >
            {loading && total === 0 && <div className="al-list-message"><LoadingState label="正在加载校对结果…" /></div>}
            {!loading && total === 0 && <div className="al-list-message"><Text weight="semibold">当前筛选没有结果</Text><Text className="al-muted">调整筛选条件，或返回任务查看扫描状态。</Text></div>}
            {total > 0 && (
              <div className="al-result-virtual-space" style={{ height: String(rowVirtualizer.getTotalSize()) + "px" }}>
                {virtualRows.map((virtualRow) => {
                  const item = items[virtualRow.index];
                  if (!item) {
                    return (
                      <div
                        key={virtualRow.key}
                        className="al-result-skeleton"
                        data-index={virtualRow.index}
                        ref={rowVirtualizer.measureElement}
                        style={{ transform: "translateY(" + String(virtualRow.start) + "px)" }}
                        aria-hidden="true"
                      >
                        <span /><span /><span />
                      </div>
                    );
                  }
                  const current = item.occurrence_id === selectedId;
                  const batchSelected = selectedBatchIds.has(item.occurrence_id);
                  const batchExcluded = batchMode && !includeReviewedInBatch && item.review_decision !== null;
                  return (
                    <button
                      type="button"
                      role="option"
                      aria-selected={batchMode ? batchSelected : current}
                      aria-current={current ? "true" : undefined}
                      aria-posinset={virtualRow.index + 1}
                      aria-setsize={total}
                      tabIndex={current ? 0 : -1}
                      key={virtualRow.key}
                      data-index={virtualRow.index}
                      data-occurrence-id={item.occurrence_id}
                      ref={(node) => {
                        if (node) {
                          optionRefs.current.set(item.occurrence_id, node);
                          rowVirtualizer.measureElement(node);
                        } else {
                          optionRefs.current.delete(item.occurrence_id);
                        }
                      }}
                      className={"al-result-item" + (current ? " current" : "") + (batchSelected ? " batch-selected" : "") + (batchExcluded ? " batch-excluded" : "")}
                      style={{ transform: "translateY(" + String(virtualRow.start) + "px)" }}
                      title={batchExcluded ? "已审核结果默认不加入批量选择" : undefined}
                      onClick={(event) => handleResultClick(event, virtualRow.index, item)}
                      onKeyDown={(event) => handleResultKeyDown(event, virtualRow.index, item)}
                    >
                      <span className="al-result-selection-mark" aria-hidden="true">{batchSelected ? "✓" : ""}</span>
                      <div className="al-result-item-content">
                        <span className="al-sequence-badge">{sequenceLabel(item.global_sequence)}</span>
                        <div className="al-result-thumbnail">
                          {assetUrl(taskId, item.page_image_relpath) ? (
                            <div className="al-result-thumbnail-canvas">
                              <img src={assetUrl(taskId, item.page_image_relpath)} alt="" loading="lazy" draggable={false} />
                              <div className="al-result-thumbnail-highlight" style={{ left: String(item.normalized_x0 * 100) + "%", top: String(item.normalized_y0 * 100) + "%", width: String((item.normalized_x1 - item.normalized_x0) * 100) + "%", height: String((item.normalized_y1 - item.normalized_y0) * 100) + "%" }} />
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
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div
          className="al-review-resizer"
          role="separator"
          tabIndex={0}
          aria-label="调整结果列表与详情宽度"
          aria-orientation="vertical"
          onPointerDown={(event) => startResize(1, event)}
          onKeyDown={(event) => resizeByKeyboard(1, event)}
        />

        {detailDrawerOpen && <button type="button" tabIndex={-1} aria-hidden="true" className="al-detail-drawer-backdrop" onClick={closeDetailDrawer} />}
        <section
          ref={detailRef}
          className={"al-detail" + (detailDrawerOpen ? " drawer-open" : "")}
          role={detailUsesDrawer ? "dialog" : undefined}
          aria-label="审核详情"
          aria-modal={detailUsesDrawer && detailDrawerOpen ? true : undefined}
          aria-hidden={detailUsesDrawer && !detailDrawerOpen ? true : undefined}
          tabIndex={detailUsesDrawer ? -1 : undefined}
        >
          {detailUsesDrawer && detailDrawerOpen && (
            <span
              className="al-detail-focus-guard"
              data-detail-focus-guard="start"
              tabIndex={0}
              onFocus={() => focusDetailDrawerEdge("last")}
            />
          )}
          {!selected ? <div className="al-review-pane-empty al-muted">选择结果进行校对</div> : (
            <>
              <div className="al-detail-heading">
                <span className="al-sequence-badge">{sequenceLabel(selected.global_sequence)}</span>
                <div>
                  <strong>{selected.matched_text}</strong>
                  <span title={selected.file_name}>{selected.file_name} · 第 {selected.page_number} 页</span>
                </div>
                <Button ref={detailDrawerCloseRef} size="small" appearance="subtle" className="al-detail-drawer-close" onClick={closeDetailDrawer}>关闭</Button>
              </div>
              <div className="al-detail-scroll">
                <div className="al-context-block al-layout-context-block">
                  <div className="al-layout-context-heading">
                    <div>
                      <span>版面 OCR 上下文</span>
                      <small>{layoutContextSubtitle(displayedLayoutContext)}</small>
                    </div>
                    {!layoutCorrectionMode && (
                      <Button size="small" appearance="subtle" disabled={!layoutContext || layoutContextLoading} onClick={openLayoutCorrection}>
                        修正版面
                      </Button>
                    )}
                  </div>
                  {layoutRebuild && layoutRebuild.remaining > 0 && (
                    <div className="al-layout-rebuild-status" role="status">
                      正在整理旧任务上下文 {layoutRebuild.completed}/{layoutRebuild.total}
                    </div>
                  )}
                  {layoutRebuild?.failed ? <InlineFeedback>有 {layoutRebuild.failed} 条上下文重建失败，可重新打开对应结果重试。</InlineFeedback> : null}
                  {layoutRebuildError && <DiagnosticErrorNotice issue={toDiagnosticIssue("REVIEW_LAYOUT_REBUILD_FAILED", new Error(layoutRebuildError))} operation="review.rebuildLayoutContexts" taskId={taskId} tone="warning" />}
                  {layoutCorrectionMode && (
                    <div className="al-layout-correction-panel">
                      <div className="al-layout-mode-buttons" role="radiogroup" aria-label="本页版面模式">
                        {([
                          ["auto", "自动"],
                          ["vertical", "竖排"],
                          ["horizontal", "横排"],
                        ] as const).map(([mode, label]) => (
                          <Button
                            key={mode}
                            size="small"
                            appearance={layoutDraftMode === mode ? "primary" : "secondary"}
                            aria-pressed={layoutDraftMode === mode}
                            disabled={layoutSaving}
                            onClick={() => void previewLayoutCorrection(mode, layoutDraftBlock)}
                          >
                            {label}
                          </Button>
                        ))}
                      </div>
                      <p>在左侧出处页点击候选版块，或拖拽框选自定义范围；右侧即时预览，只保存到当前页。</p>
                      <div className="al-layout-correction-actions">
                        <Button size="small" appearance="primary" disabled={layoutSaving} onClick={() => void saveLayoutOverride(false)}>
                          {layoutSaving ? "正在处理…" : "保存到本页"}
                        </Button>
                        {layoutContext?.has_page_override && (
                          <Button size="small" disabled={layoutSaving} onClick={() => void saveLayoutOverride(true)}>清除本页修正</Button>
                        )}
                        <Button size="small" appearance="subtle" disabled={layoutSaving} onClick={cancelLayoutCorrection}>取消</Button>
                      </div>
                    </div>
                  )}
                  {layoutContextError && <DiagnosticErrorNotice issue={toDiagnosticIssue("REVIEW_LAYOUT_CONTEXT_FAILED", new Error(layoutContextError))} operation="review.layoutContext" taskId={taskId} tone="warning" />}
                  {layoutContextLoading && !displayedLayoutContext && <LoadingState label="正在重建当前版面上下文…" />}
                  {displayedLayoutContext?.status === "uncertain" && (
                    <div className="al-layout-uncertain" role="status">
                      <strong>版面结构待确认</strong>
                      <span>为避免拼接可疑内容，当前只显示命中{displayedLayoutContext.orientation === "vertical" ? "列" : "行"}。</span>
                    </div>
                  )}
                  {displayedLayoutContext ? (
                    <LayoutContextCanvas context={displayedLayoutContext} />
                  ) : !layoutContextLoading ? (
                    <p className="al-layout-context-fallback">{selected.context_full || "未提供上下文"}</p>
                  ) : null}
                </div>
                <details className="al-review-metadata">
                  <summary>证据与判断</summary>
                  <div className="al-review-facts">
                    <div><span>永久序号</span><strong>{sequenceLabel(selected.global_sequence)}</strong></div>
                    <div><span>OCR 置信度</span><strong>{confidenceLabel(selected.ocr_confidence)}</strong></div>
                    <div><span>系统判断</span><strong>{verificationLabel(selected.verification_status)}</strong></div>
                    <div><span>人工结论</span><strong>{decisionLabel(selected.review_decision)}</strong></div>
                  </div>
                </details>
                <div className={"al-review-note-panel" + (noteExpanded ? " expanded" : " compact")}>
                  {noteExpanded ? (
                    <>
                      <div className="al-note-heading">
                        <span>校对备注</span>
                        {!note.trim() && <Button size="small" appearance="subtle" onClick={() => setNoteExpanded(false)}>收起</Button>}
                      </div>
                      <Textarea ref={noteRef} value={note} onChange={(_, data) => updateNoteDraft(data.value)} placeholder="输入备注，停顿后自动保存" aria-label="校对备注" className="al-note" />
                      <div className="al-note-actions">
                        <span className="al-save-state" role="status">{saveStateLabel}</span>
                        <Button size="small" onClick={() => void saveNote()}>立即保存 Ctrl+Enter</Button>
                      </div>
                    </>
                  ) : (
                    <button type="button" className="al-note-summary" onClick={() => { setNoteExpanded(true); window.setTimeout(() => noteRef.current?.focus(), 0); }}>
                      <span>备注</span>
                      <strong>{note || "添加备注"}</strong>
                      <small>{shortcutLabel("toggle_note")}</small>
                    </button>
                  )}
                </div>
              </div>
              <div className="al-review-command-bar">
                <div className="al-decision-actions" aria-label="校对判断">
                  <Button disabled={actionBusy} appearance={selected.review_decision === "confirmed" ? "primary" : "secondary"} aria-pressed={selected.review_decision === "confirmed"} title={`确认命中 ${shortcutLabel("confirm")}`} onClick={() => void applyDecision("confirmed")}>确认 {shortcutLabel("confirm")}</Button>
                  <Button disabled={actionBusy} appearance={selected.review_decision === "needs_review" ? "primary" : "secondary"} aria-pressed={selected.review_decision === "needs_review"} title={`需要复核 ${shortcutLabel("needs_review")}`} onClick={() => void applyDecision("needs_review")}>待复核 {shortcutLabel("needs_review")}</Button>
                  <Button disabled={actionBusy} appearance={selected.review_decision === "rejected" ? "primary" : "secondary"} aria-pressed={selected.review_decision === "rejected"} title={`拒绝命中 ${shortcutLabel("reject")}`} onClick={() => void applyDecision("rejected")}>拒绝 {shortcutLabel("reject")}</Button>
                </div>
                <div className="al-navigation-actions" aria-label="结果导航">
                  <Button disabled={actionBusy} onClick={() => void goPrev()}>上一条 {shortcutLabel("previous")}</Button>
                  <Button disabled={actionBusy} appearance="primary" aria-label={`下一条待处理 ${shortcutLabel("next_pending")}`} title={`下一条待处理 ${shortcutLabel("next_pending")}`} onClick={() => void goNext(true)}>待处理 {shortcutLabel("next_pending")}</Button>
                  <Button disabled={actionBusy} onClick={() => void goNext()}>下一条 {shortcutLabel("next")}</Button>
                </div>
              </div>
            </>
          )}
          {detailUsesDrawer && detailDrawerOpen && (
            <span
              className="al-detail-focus-guard"
              data-detail-focus-guard="end"
              tabIndex={0}
              onFocus={() => focusDetailDrawerEdge("first")}
            />
          )}
        </section>
      </div>

      <Dialog open={shortcutsOpen} onOpenChange={(_, data) => setShortcutsOpen(data.open)}>
        <DialogSurface className="al-shortcut-dialog">
          <DialogBody>
            <DialogTitle>审核快捷键</DialogTitle>
            <DialogContent>
              <div className="al-shortcut-grid">
                <span><kbd>{shortcutLabel("confirm")}</kbd><b>确认命中</b></span>
                <span><kbd>{shortcutLabel("needs_review")}</kbd><b>标记待复核</b></span>
                <span><kbd>{shortcutLabel("reject")}</kbd><b>拒绝命中</b></span>
                <span><kbd>{shortcutLabel("next")} / ↓</kbd><b>下一条</b></span>
                <span><kbd>{shortcutLabel("previous")} / ↑</kbd><b>上一条</b></span>
                <span><kbd>{shortcutLabel("next_pending")}</kbd><b>下一条待处理</b></span>
                <span><kbd>{shortcutLabel("toggle_view")}</kbd><b>适应页面／原始比例</b></span>
                <span><kbd>{shortcutLabel("focus_image")}</kbd><b>图像专注</b></span>
                <span><kbd>{shortcutLabel("toggle_note")}</kbd><b>编辑备注</b></span>
                <span><kbd>Ctrl+Z</kbd><b>撤销审核</b></span>
                <span><kbd>Ctrl+Shift+Z</kbd><b>重做审核</b></span>
                <span><kbd>?</kbd><b>打开本面板</b></span>
              </div>
            </DialogContent>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
