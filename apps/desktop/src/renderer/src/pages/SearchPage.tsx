import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button, Input, Text } from "@fluentui/react-components";
import {
  FullScreenMaximizeRegular,
  ZoomInRegular,
  ZoomOutRegular,
} from "@fluentui/react-icons";
import {
  DEFAULT_SEARCH_SCRIPT_SCOPE,
  type OcrCorpusStatusResult,
  type OcrSearchHit,
  type OcrSearchHitsResult,
  type OcrSearchSession,
  type ReviewPageImageResult,
  type SearchScriptScope,
} from "@shared/index";
import type { TaskSummary } from "../../../preload/api";
import { InlineFeedback, LoadingState, PageHeader } from "../components/feedback";
import { formatDateTime, taskDisplayName } from "../utils/presentation";

const PAGE_SIZE = 50;

const SCRIPT_SCOPE_LABELS: Record<SearchScriptScope, string> = {
  simplified: "只命中简体",
  traditional: "只命中繁体",
  both: "简体和繁体",
};

const SCRIPT_LABELS: Record<string, string> = {
  simplified: "简体原字形",
  traditional: "繁体原字形",
  neutral: "简繁共用字形",
  mixed: "简繁混合字形",
  unknown: "字形未知",
};

const LAYER_LABELS: Record<string, string> = {
  raw_exact: "原文精确命中",
  context_resolved: "上下文识别命中",
  variant_graph: "简繁字形索引命中",
  ocr_top_k: "OCR Top-K 候选",
};

const VERIFICATION_LABELS: Record<string, string> = {
  source_exact: "原字形精确",
  context_resolved: "上下文消歧",
  variant_related: "字形关联，需结合原图",
  candidate_pending_review: "候选待人工核查",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请重试";
}

function assetUrl(taskId: string, rel: string | null, version?: string): string {
  if (!rel) return "";
  const query = version ? `?v=${encodeURIComponent(version)}` : "";
  return `al-resource://${taskId}/${rel.replace(/^\/+/, "")}${query}`;
}

function payloadText(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value ? value : null;
}

function corpusStatusLabel(status: OcrCorpusStatusResult["status"]): string {
  const labels: Record<OcrCorpusStatusResult["status"], string> = {
    not_built: "尚未建立",
    building: "正在建立",
    ready: "完整可检索",
    partial: "可检索但尚未完整",
    failed: "建立失败",
    legacy_requires_reocr: "旧任务需重新 OCR",
  };
  return labels[status];
}

function layerClass(layer: OcrSearchHit["match_layer"]): string {
  return `al-search-layer-${layer.replaceAll("_", "-")}`;
}

export default function SearchPage() {
  const { taskId = "" } = useParams();
  const nav = useNavigate();
  const [task, setTask] = useState<TaskSummary | null>(null);
  const [corpus, setCorpus] = useState<OcrCorpusStatusResult | null>(null);
  const [sessions, setSessions] = useState<OcrSearchSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<OcrSearchSession | null>(null);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SearchScriptScope>(DEFAULT_SEARCH_SCRIPT_SCOPE);
  const [hits, setHits] = useState<OcrSearchHit[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [selectedHitId, setSelectedHitId] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [hitsLoading, setHitsLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [pageImage, setPageImage] = useState<ReviewPageImageResult | null>(null);
  const [pageImageLoading, setPageImageLoading] = useState(false);
  const [pageImageError, setPageImageError] = useState("");
  const [zoom, setZoom] = useState(1);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const hitRequestRef = useRef(0);
  const imageRequestRef = useRef(0);
  const fitWhenReadyRef = useRef(true);

  const corpusReady = corpus?.status === "ready" || corpus?.status === "partial";
  const selected = useMemo(
    () => hits.find((hit) => hit.search_hit_id === selectedHitId) ?? null,
    [hits, selectedHitId],
  );
  const selectedIndex = selected
    ? hits.findIndex((hit) => hit.search_hit_id === selected.search_hit_id)
    : -1;
  const pageNumber = Math.floor(offset / PAGE_SIZE) + 1;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  useEffect(() => {
    let active = true;
    setInitialLoading(true);
    setError("");
    setTask(null);
    setCorpus(null);
    setSessions([]);
    setActiveSessionId(null);
    setActiveSession(null);
    setHits([]);
    setTotal(0);
    setOffset(0);
    setSelectedHitId(null);
    Promise.all([
      window.archiveLens.tasks.get(taskId),
      window.archiveLens.search.getCorpusStatus(taskId),
      window.archiveLens.settings.get(),
      window.archiveLens.search.listSessions(taskId, 100),
    ]).then(([nextTask, nextCorpus, settings, history]) => {
      if (!active) return;
      setTask(nextTask);
      setCorpus(nextCorpus);
      setScope(settings.search_script_scope);
      setQuery(nextTask.search_text || "");
      setSessions(history.items);
      const latest = history.items[0];
      if (latest) {
        setActiveSessionId(latest.search_session_id);
        setActiveSession(latest);
        setQuery(latest.query_text);
        setScope(latest.script_scope);
      }
    }).catch((loadError: unknown) => {
      if (active) setError(`读取任务检索数据失败：${errorMessage(loadError)}`);
    }).finally(() => {
      if (active) setInitialLoading(false);
    });
    return () => {
      active = false;
      hitRequestRef.current += 1;
      imageRequestRef.current += 1;
    };
  }, [taskId]);

  const loadHits = useCallback(async (sessionId: string, nextOffset: number) => {
    const requestId = ++hitRequestRef.current;
    setHitsLoading(true);
    setError("");
    try {
      const result: OcrSearchHitsResult = await window.archiveLens.search.queryHits({
        task_id: taskId,
        search_session_id: sessionId,
        limit: PAGE_SIZE,
        offset: nextOffset,
      });
      if (requestId !== hitRequestRef.current) return;
      setHits(result.items);
      setTotal(result.total);
      setActiveSession(result.session);
      setSelectedHitId((current) => (
        result.items.some((item) => item.search_hit_id === current)
          ? current
          : result.items[0]?.search_hit_id ?? null
      ));
    } catch (loadError: unknown) {
      if (requestId !== hitRequestRef.current) return;
      setHits([]);
      setTotal(0);
      setSelectedHitId(null);
      setError(`读取检索结果失败：${errorMessage(loadError)}`);
    } finally {
      if (requestId === hitRequestRef.current) setHitsLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    if (!activeSessionId) return;
    void loadHits(activeSessionId, offset);
  }, [activeSessionId, loadHits, offset]);

  useEffect(() => {
    const element = viewerRef.current;
    if (!element) return;
    const update = () => setViewportSize({
      width: Math.max(1, element.clientWidth),
      height: Math.max(1, element.clientHeight),
    });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [selected?.search_hit_id]);

  useEffect(() => {
    imageRequestRef.current += 1;
    fitWhenReadyRef.current = true;
    setPageImage(null);
    setPageImageError("");
    setPageImageLoading(false);
    setZoom(1);
  }, [selected?.search_hit_id]);

  useEffect(() => {
    if (!selected || viewportSize.width <= 0 || viewportSize.height <= 0) return;
    const requestId = ++imageRequestRef.current;
    let active = true;
    const timer = window.setTimeout(() => {
      setPageImageLoading(true);
      setPageImageError("");
      void window.archiveLens.search.preparePageImage({
        task_id: taskId,
        search_hit_id: selected.search_hit_id,
        target_css_width: Math.max(1, pageImage?.width_100_css ? pageImage.width_100_css * zoom : viewportSize.width),
        target_css_height: Math.max(1, pageImage?.height_100_css ? pageImage.height_100_css * zoom : viewportSize.height),
        device_pixel_ratio: Math.min(4, Math.max(0.5, window.devicePixelRatio || 1)),
      }).then((result: ReviewPageImageResult) => {
        if (!active || requestId !== imageRequestRef.current) return;
        setPageImage(result);
        if (fitWhenReadyRef.current) {
          fitWhenReadyRef.current = false;
          setZoom(Math.min(
            1,
            viewportSize.width / result.width_100_css,
            viewportSize.height / result.height_100_css,
          ));
        }
      }).catch((imageError: unknown) => {
        if (active && requestId === imageRequestRef.current) {
          setPageImageError(errorMessage(imageError));
        }
      }).finally(() => {
        if (active && requestId === imageRequestRef.current) setPageImageLoading(false);
      });
    }, 150);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [pageImage?.height_100_css, pageImage?.width_100_css, selected, taskId, viewportSize.height, viewportSize.width, zoom]);

  const chooseSession = (session: OcrSearchSession) => {
    setActiveSessionId(session.search_session_id);
    setActiveSession(session);
    setQuery(session.query_text);
    setScope(session.script_scope);
    setOffset(0);
  };

  const executeSearch = async () => {
    if (!corpusReady || searching || !query) return;
    setSearching(true);
    setError("");
    try {
      const session = await window.archiveLens.search.execute({
        task_id: taskId,
        query_text: query,
        script_scope: scope,
      });
      setSessions((current) => [session, ...current.filter((item) => item.search_session_id !== session.search_session_id)]);
      setActiveSession(session);
      setActiveSessionId(session.search_session_id);
      setOffset(0);
    } catch (searchError: unknown) {
      setError(`检索失败：${errorMessage(searchError)}`);
    } finally {
      setSearching(false);
    }
  };

  const rescanTask = () => {
    if (!task) return;
    nav("/scan/new", {
      state: task.source_kind === "files"
        ? { sourceKind: "files", sourceFiles: task.source_files, sourceTaskId: task.task_id }
        : { sourceDir: task.source_dir, sourceTaskId: task.task_id },
    });
  };

  const fitPage = () => {
    if (!pageImage) {
      fitWhenReadyRef.current = true;
      return;
    }
    fitWhenReadyRef.current = false;
    setZoom(Math.min(
      1,
      viewportSize.width / pageImage.width_100_css,
      viewportSize.height / pageImage.height_100_css,
    ));
  };

  const selectAdjacent = (direction: -1 | 1) => {
    const next = hits[selectedIndex + direction];
    if (next) setSelectedHitId(next.search_hit_id);
  };

  const imageWidth = (pageImage?.width_100_css ?? 0) * zoom;
  const imageHeight = (pageImage?.height_100_css ?? 0) * zoom;
  const semanticLabel = activeSession?.query_forms.semantic_label ?? null;

  return (
    <div className="al-search-page">
      <div className="al-search-title">
        <PageHeader
          title="任务内检索"
          description={task ? `${taskDisplayName(task)} · 在本地不可变 OCR 原文及简繁字形索引中重复检索` : "在本地 OCR 语料中重复检索"}
        />
      </div>

      <form className="al-search-toolbar" onSubmit={(event) => { event.preventDefault(); void executeSearch(); }}>
        <Input
          value={query}
          aria-label="任务内检索文字或词语"
          placeholder="输入单字或词语"
          disabled={!corpusReady || searching}
          onChange={(_, data) => setQuery(data.value)}
        />
        <select
          value={scope}
          aria-label="命中字形范围"
          disabled={!corpusReady || searching}
          onChange={(event) => setScope(event.target.value as SearchScriptScope)}
        >
          <option value="both">简体和繁体</option>
          <option value="simplified">只命中简体</option>
          <option value="traditional">只命中繁体</option>
        </select>
        <Button type="submit" appearance="primary" disabled={!corpusReady || searching || !query}>
          {searching ? "正在检索…" : "检索"}
        </Button>
        <select
          className="al-search-history-select"
          value={activeSessionId ?? ""}
          aria-label="历史检索会话"
          disabled={sessions.length === 0}
          onChange={(event) => {
            const session = sessions.find((item) => item.search_session_id === event.target.value);
            if (session) chooseSession(session);
          }}
        >
          <option value="">{sessions.length ? "选择历史检索" : "暂无检索历史"}</option>
          {sessions.map((session) => (
            <option key={session.search_session_id} value={session.search_session_id}>
              {session.query_text} · {SCRIPT_SCOPE_LABELS[session.script_scope]} · {session.counts.total} 条
            </option>
          ))}
        </select>
        <Button appearance="subtle" onClick={() => nav("/settings")}>默认范围设置</Button>
      </form>

      {initialLoading && <div className="al-search-page-message"><LoadingState label="正在读取本地 OCR 语料与检索历史…" /></div>}
      {error && <div className="al-search-page-message"><InlineFeedback>{error}</InlineFeedback></div>}

      {!initialLoading && corpus && (
        <div className="al-search-summary" role="status">
          <span>语料：<strong>{corpusStatusLabel(corpus.status)}</strong></span>
          <span>已索引页：<strong>{corpus.indexed_pages}</strong></span>
          <span>OCR 行：<strong>{corpus.line_count}</strong></span>
          {activeSession && <span>当前结果：<strong>{activeSession.counts.total}</strong></span>}
          {activeSession && <span>范围：<strong>{SCRIPT_SCOPE_LABELS[activeSession.script_scope]}</strong></span>}
          {semanticLabel && <span title="OpenCC 词语证据或字形关联结论">索引语义：<strong>{semanticLabel}</strong></span>}
        </div>
      )}

      {!initialLoading && corpus?.status === "partial" && (
        <div className="al-search-page-message"><InlineFeedback tone="warning">当前任务仍在处理或含失败页，只检索已持久化的 {corpus.indexed_pages} 页；结果可能继续增加，也可能存在漏检。</InlineFeedback></div>
      )}
      {!initialLoading && corpus?.status === "legacy_requires_reocr" && (
        <div className="al-search-page-message"><InlineFeedback tone="warning">该旧任务没有新版本的不可变 OCR 语料和简繁索引，不能静默迁移。请显式使用原来源重新扫描。 <Button size="small" onClick={rescanTask}>使用原来源重新扫描</Button></InlineFeedback></div>
      )}
      {!initialLoading && corpus && !corpusReady && corpus.status !== "legacy_requires_reocr" && (
        <div className="al-search-page-message"><InlineFeedback tone="info">当前 OCR 语料{corpusStatusLabel(corpus.status)}，暂不能执行任务内检索。可返回任务详情查看扫描状态。 <Button size="small" onClick={() => nav(`/tasks/${taskId}`)}>查看任务</Button></InlineFeedback></div>
      )}

      {!initialLoading && corpusReady && (
        <div className="al-search-body">
          <aside className="al-search-history" aria-label="检索历史">
            <div className="al-search-pane-heading"><strong>检索历史</strong><span>{sessions.length} 次</span></div>
            <div className="al-search-history-scroll">
              {sessions.length === 0 && <Text className="al-muted">首次检索后，会话和命中证据会保存在当前任务中。</Text>}
              {sessions.map((session) => (
                <button
                  type="button"
                  key={session.search_session_id}
                  className={session.search_session_id === activeSessionId ? "selected" : ""}
                  onClick={() => chooseSession(session)}
                >
                  <strong>{session.query_text}</strong>
                  <span>{SCRIPT_SCOPE_LABELS[session.script_scope]} · {session.counts.total} 条</span>
                  <small>{formatDateTime(session.created_at)}</small>
                </button>
              ))}
            </div>
          </aside>

          <section className="al-search-results" aria-label="检索结果">
            <div className="al-search-pane-heading"><strong>分层结果</strong><span>{total} 条</span></div>
            {activeSession && (
              <div className="al-search-layer-counts" aria-label="检索层级统计">
                <span>原文 {activeSession.counts.layers.raw_exact ?? 0}</span>
                <span>上下文 {activeSession.counts.layers.context_resolved ?? 0}</span>
                <span>字形图 {activeSession.counts.layers.variant_graph ?? 0}</span>
                <span>Top-K {activeSession.counts.layers.ocr_top_k ?? 0}</span>
              </div>
            )}
            <div className="al-search-result-scroll" role="listbox" aria-busy={hitsLoading} aria-label="分层检索命中列表">
              {hitsLoading && hits.length === 0 && <div className="al-list-message"><LoadingState label="正在读取命中证据…" /></div>}
              {!hitsLoading && activeSession && hits.length === 0 && <div className="al-list-message"><Text weight="semibold">没有符合当前字形范围的结果</Text><Text className="al-muted">可切换简繁范围或输入其他词语；OCR 原文不会被转换。</Text></div>}
              {!hitsLoading && !activeSession && <div className="al-list-message"><Text weight="semibold">输入词语开始检索</Text><Text className="al-muted">检索会按原文、上下文、字形图、Top-K 候选依次分层。</Text></div>}
              {hits.map((hit) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={selectedHitId === hit.search_hit_id}
                  key={hit.search_hit_id}
                  className={`al-search-result ${selectedHitId === hit.search_hit_id ? "selected" : ""}`}
                  onClick={() => setSelectedHitId(hit.search_hit_id)}
                >
                  <div><span className={`al-search-layer ${layerClass(hit.match_layer)}`}>{LAYER_LABELS[hit.match_layer]}</span><small>{SCRIPT_LABELS[hit.source_script] ?? hit.source_script}</small></div>
                  <strong>{hit.raw_text || "（OCR 原文为空）"}</strong>
                  {hit.resolved_text !== hit.raw_text && <span>上下文识别：{hit.resolved_text}</span>}
                  <span>{hit.file_name} · 第 {hit.page_no} 页</span>
                </button>
              ))}
            </div>
            {activeSession && total > 0 && (
              <div className="al-pagination">
                <Button size="small" disabled={offset === 0 || hitsLoading} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>上一页</Button>
                <span>第 {pageNumber}/{totalPages} 页</span>
                <Button size="small" disabled={offset + PAGE_SIZE >= total || hitsLoading} onClick={() => setOffset(offset + PAGE_SIZE)}>下一页</Button>
              </div>
            )}
          </section>

          <section className="al-search-detail" aria-label="人工核查">
            {!selected && <div className="al-empty"><Text weight="semibold">选择一条结果进行人工核查</Text><Text className="al-muted">页面将显示真实来源图像、高亮位置、不可变 OCR 原文和命中层级。</Text></div>}
            {selected && (
              <>
                <div className="al-search-detail-heading">
                  <div><strong>{selected.file_name}</strong><span>第 {selected.page_no} 页 · 第 {selected.line_index + 1} 行</span></div>
                  <div><Button size="small" disabled={selectedIndex <= 0} onClick={() => selectAdjacent(-1)}>上一条</Button><Button size="small" disabled={selectedIndex < 0 || selectedIndex >= hits.length - 1} onClick={() => selectAdjacent(1)}>下一条</Button></div>
                </div>
                {selected.verification_status === "candidate_pending_review" && <InlineFeedback tone="warning">这是孤立单字的 OCR Top-K 候选，不是 OCR 主结果，必须对照原图人工核查。</InlineFeedback>}
                <div ref={viewerRef} className="al-search-viewer">
                  <div className="al-viewer-overlays">
                    <div className="al-viewer-toolbar" aria-label="页面缩放工具">
                      <Button appearance="subtle" size="small" icon={<ZoomOutRegular />} aria-label="缩小页面" onClick={() => { fitWhenReadyRef.current = false; setZoom((value) => Math.max(0.02, value * 0.8)); }} />
                      <span className="al-zoom-value">{Math.round(zoom * 100)}%</span>
                      <Button appearance="subtle" size="small" icon={<ZoomInRegular />} aria-label="放大页面" onClick={() => { fitWhenReadyRef.current = false; setZoom((value) => Math.min(4, value * 1.25)); }} />
                      <Button appearance="subtle" size="small" onClick={() => { fitWhenReadyRef.current = false; setZoom(1); }}>100%</Button>
                      <Button appearance="subtle" size="small" icon={<FullScreenMaximizeRegular />} onClick={fitPage}>适应窗口</Button>
                    </div>
                    {pageImageLoading && <div className="al-page-fidelity-status">正在加载原始清晰度…</div>}
                    {pageImage?.overscale_warning && zoom > 1 && <div className="al-page-fidelity-warning">{pageImage.overscale_warning}</div>}
                  </div>
                  {pageImageError && <div className="al-page-fidelity-error" role="alert">页面证据加载失败：{pageImageError}</div>}
                  <div className="al-search-viewer-scroll">
                    {pageImage && (
                      <div className="al-search-page-canvas" style={{ width: `${imageWidth}px`, height: `${imageHeight}px` }}>
                        <img src={assetUrl(taskId, pageImage.asset_relpath, pageImage.asset_version)} alt="检索结果出处页" draggable={false} />
                        <div className="al-search-highlight" style={{ left: `${selected.normalized_x0 * 100}%`, top: `${selected.normalized_y0 * 100}%`, width: `${Math.max(0, selected.normalized_x1 - selected.normalized_x0) * 100}%`, height: `${Math.max(0, selected.normalized_y1 - selected.normalized_y0) * 100}%` }} />
                      </div>
                    )}
                  </div>
                </div>
                <div className="al-search-evidence">
                  <div className="al-search-raw-evidence"><span>OCR 原文（不可变）</span><strong>{selected.raw_text || "（空）"}</strong></div>
                  <div><span>上下文识别文本</span><strong>{selected.resolved_text || "（空）"}</strong></div>
                  <div><span>命中层级</span><strong>{LAYER_LABELS[selected.match_layer]}</strong></div>
                  <div><span>核查状态</span><strong>{VERIFICATION_LABELS[selected.verification_status] ?? selected.verification_status}</strong></div>
                  <div><span>图片原字形</span><strong>{SCRIPT_LABELS[selected.source_script] ?? selected.source_script}</strong></div>
                  <div><span>匹配文本</span><strong>{selected.matched_text}</strong></div>
                  <div><span>OCR 置信度</span><strong>{selected.line_confidence.toFixed(3)}</strong></div>
                  <div><span>索引类型</span><strong>{selected.index_kind}</strong></div>
                </div>
                {(payloadText(selected.payload, "semantic_label") || semanticLabel) && (
                  <Text className="al-search-semantic-note">索引说明：{payloadText(selected.payload, "semantic_label") ?? semanticLabel}。字形关联不等同于语义确认，请以原图和上下文为准。</Text>
                )}
                <Text className="al-muted">本页只用于检索与人工核查，不修改 OCR 原文；校正层和正式校正界面留待后续批准的独立批次。</Text>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
