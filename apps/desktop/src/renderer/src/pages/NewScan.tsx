import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button, Card, Checkbox, Input, Spinner, Text } from "@fluentui/react-components";
import {
  MAX_SOURCE_FILES,
  DEFAULT_REVIEW_DISPLAY_PREFERENCES,
  DEFAULT_SEARCH_SCRIPT_SCOPE,
  SUPPORTED_SOURCE_FORMAT_LABEL,
  SearchTextSchema,
  TaskCreateParamsSchema,
  type ReviewDisplayPreferences,
  type ReviewHighlightSettingsResult,
  type SearchScriptScope,
  type SourcePreflightJob,
  type SourcePreflightResult,
} from "@archivelens/ipc-schema";
import { InlineFeedback, PageHeader } from "../components/feedback";
import { buildTaskName, sourceBaseName } from "../utils/presentation";

type SourceType = "folder" | "single" | "multiple";

const SOURCE_OPTIONS: Array<{ id: SourceType; title: string; detail: string }> = [
  { id: "folder", title: "整个文件夹", detail: `递归扫描文件夹中的 ${SUPPORTED_SOURCE_FORMAT_LABEL} 档案。` },
  { id: "single", title: "单个文件", detail: `只扫描一个指定的 ${SUPPORTED_SOURCE_FORMAT_LABEL} 文件。` },
  { id: "multiple", title: "多个文件", detail: `将 1–${MAX_SOURCE_FILES} 个指定文件放进同一个任务，可跨目录选择。` },
];

const DIRECTION_LABELS: Record<ReviewDisplayPreferences["context_direction"], string> = {
  ltr: "从左到右",
  rtl: "从右到左",
  ttb: "从上到下",
  btt: "从下到上",
};

function dedupeFiles(paths: string[]): { files: string[]; removed: number } {
  const seen = new Set<string>();
  const files = paths.filter((path) => {
    const key = path.trim().toLocaleLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { files, removed: paths.length - files.length };
}

function formatBytes(value: number): string {
  if (value < 0) return "无法取得";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 100 || unit === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[unit]}`;
}

function PreflightSummary({
  result,
  confirmed,
  onConfirmed,
}: {
  result: SourcePreflightResult;
  confirmed: boolean;
  onConfirmed: (value: boolean) => void;
}) {
  const details = [
    ...result.invalid_files.map((item) => ({ ...item, kind: "无效文件" })),
    ...result.inaccessible_files.map((item) => ({ ...item, kind: "无法读取" })),
    ...result.skipped_links.map((item) => ({ ...item, kind: "已跳过链接" })),
  ];
  return <>
    <div className="al-preflight-grid" aria-label="文件夹预检结果">
      <span>支持的档案<strong>{result.supported_file_count} 个</strong></span>
      <span>格式分布<strong>{Object.entries(result.format_counts).filter(([, count]) => count > 0).map(([name, count]) => `${name.toUpperCase()} ${count}`).join(" · ") || "无"}</strong></span>
      <span>来源总体积<strong>{formatBytes(result.total_bytes)}</strong></span>
      <span>{result.page_count_complete ? "总页数" : "已知页数"}<strong>{result.known_pages} 页</strong></span>
      <span>可用磁盘<strong>{formatBytes(result.available_disk_bytes)}</strong></span>
      <span>保守空间估算<strong>{formatBytes(result.estimated_required_disk_bytes)}</strong></span>
    </div>
    <Text className="al-muted">空间估算包含 OCR 数据、页面证据、导出临时空间和安全余量，不会复制或删除原始档案。</Text>
    {result.warnings.map((warning) => <InlineFeedback key={warning.code} tone="warning">{warning.message}</InlineFeedback>)}
    {result.blocking_codes.length > 0 && <InlineFeedback>预检存在阻塞项（{result.blocking_codes.join("、")}），任务不会创建。</InlineFeedback>}
    {details.length > 0 && <div className="al-failure-list" aria-label="预检风险明细">{details.map((item, index) => <div key={`${item.kind}-${item.path}-${index}`}><strong>{item.kind}</strong><span title={item.path}>{item.path}</span><small>{item.reason}</small></div>)}</div>}
    {result.truncated_details && <Text className="al-muted">明细较多，当前仅显示前 {details.length} 项。</Text>}
    {result.requires_confirmation && result.can_create && <Checkbox checked={confirmed} onChange={(_, data) => onConfirmed(data.checked === true)} label="我已了解上述规模、链接、网络或磁盘风险，仍要创建任务" />}
    {result.can_create && !result.requires_confirmation && <InlineFeedback tone="info">预检通过，可以创建扫描任务。</InlineFeedback>}
  </>;
}

export default function NewScan() {
  const nav = useNavigate();
  const location = useLocation();
  const initial = location.state as { sourceDir?: unknown; sourceFiles?: unknown; sourceKind?: unknown; sourceTaskId?: unknown } | null;
  const sourceTaskId = typeof initial?.sourceTaskId === "string" ? initial.sourceTaskId : undefined;
  const initialFiles = Array.isArray(initial?.sourceFiles) && initial.sourceFiles.every((path) => typeof path === "string")
    ? dedupeFiles(initial.sourceFiles).files
    : [];
  const initialSourceType: SourceType = initialFiles.length > 1 ? "multiple" : initialFiles.length === 1 ? "single" : "folder";
  const [sourceType, setSourceType] = useState<SourceType>(initial?.sourceKind === "files" ? initialSourceType : "folder");
  const [dir, setDir] = useState(typeof initial?.sourceDir === "string" ? initial.sourceDir : "");
  const [files, setFiles] = useState(initialFiles);
  const [selectionNote, setSelectionNote] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewPreferences, setReviewPreferences] = useState<ReviewDisplayPreferences>(DEFAULT_REVIEW_DISPLAY_PREFERENCES);
  const [searchScriptScope, setSearchScriptScope] = useState<SearchScriptScope>(DEFAULT_SEARCH_SCRIPT_SCOPE);
  const [preferencesLoading, setPreferencesLoading] = useState(true);
  const [preferencesError, setPreferencesError] = useState<string | null>(null);
  const [preflightJob, setPreflightJob] = useState<SourcePreflightJob | null>(null);
  const [preflightConfirmed, setPreflightConfirmed] = useState(false);
  const preflightGeneration = useRef(0);

  useEffect(() => {
    let active = true;
    setPreferencesLoading(true);
    setPreferencesError(null);
    window.archiveLens.settings.get(sourceTaskId).then((settings: ReviewHighlightSettingsResult) => {
      if (active) {
        setReviewPreferences(settings.effective_preferences);
        setSearchScriptScope(settings.search_script_scope);
      }
    }).catch((nextError: unknown) => {
      if (active) setPreferencesError(nextError instanceof Error ? nextError.message : "无法读取校对显示设置");
    }).finally(() => {
      if (active) setPreferencesLoading(false);
    });
    return () => { active = false; };
  }, [sourceTaskId]);
  useEffect(() => () => { preflightGeneration.current += 1; }, []);
  const searchValidation = SearchTextSchema.safeParse(searchText);
  const searchError = searchText && !searchValidation.success
    ? searchValidation.error.issues[0]?.message ?? "检索词无效"
    : null;
  const isFileSource = sourceType === "single" || sourceType === "multiple";
  const sourceLabel = sourceType === "folder"
    ? (dir || "尚未选择")
    : files.length === 1 ? sourceBaseName(files[0]!) : files.length ? `${files.length} 个已选文件` : "尚未选择";
  const preflightResult = preflightJob?.status === "completed" ? preflightJob.result : null;
  const taskInput = sourceType === "folder"
    ? {
      source_type: "folder" as const,
      source_dir: dir,
      search_text: searchText,
      search_script_scope: searchScriptScope,
      review_preferences: reviewPreferences,
      ...(preflightResult ? {
        preflight_token: preflightResult.scan_token,
        preflight_confirmed: preflightConfirmed,
      } : {}),
    }
    : { source_type: "files" as const, source_files: files, search_text: searchText, search_script_scope: searchScriptScope, review_preferences: reviewPreferences };
  const parsedTask = TaskCreateParamsSchema.safeParse(taskInput);
  const folderPreflightReady = sourceType !== "folder" || Boolean(
    preflightResult
    && preflightJob?.source_dir.toLocaleLowerCase() === dir.toLocaleLowerCase()
    && preflightResult.can_create
    && (!preflightResult.requires_confirmation || preflightConfirmed),
  );
  const canStart = parsedTask.success && !preferencesLoading && !preferencesError && folderPreflightReady;
  const disabledReason = busy
    ? "正在创建任务，请稍候"
    : preferencesLoading
      ? "正在读取校对显示与上下文设置"
      : preferencesError
        ? `设置读取失败：${preferencesError}`
    : sourceType === "folder" && !dir
      ? `请先选择包含 ${SUPPORTED_SOURCE_FORMAT_LABEL} 的文件夹`
      : sourceType === "folder" && ["queued", "running", "cancelling"].includes(preflightJob?.status ?? "")
        ? "正在预检文件夹，请稍候"
        : sourceType === "folder" && preflightJob?.status === "failed"
          ? `文件夹预检失败：${preflightJob.error_message || "请重试"}`
          : sourceType === "folder" && preflightJob?.status === "cancelled"
            ? "文件夹预检已取消，请重新预检"
            : sourceType === "folder" && preflightResult && !preflightResult.can_create
              ? "请先处理预检发现的阻塞项"
              : sourceType === "folder" && preflightResult?.requires_confirmation && !preflightConfirmed
                ? "请确认已了解大任务、链接、网络或磁盘风险"
                : sourceType === "folder" && !preflightResult
                  ? "需要先完成文件夹预检"
      : isFileSource && files.length === 0
        ? "请先选择要扫描的文件"
        : files.length > MAX_SOURCE_FILES
          ? `同一个文件清单任务最多支持 ${MAX_SOURCE_FILES} 个文件`
          : !searchText
            ? "请输入检索文字或词语"
            : searchError || "";

  async function runPreflight(sourceDir: string) {
    const generation = preflightGeneration.current + 1;
    preflightGeneration.current = generation;
    setPreflightConfirmed(false);
    setPreflightJob(null);
    setError(null);
    try {
      let job = await window.archiveLens.tasks.preflight(sourceDir);
      if (preflightGeneration.current !== generation) {
        void window.archiveLens.tasks.cancelPreflight(job.preflight_id).catch(() => undefined);
        return;
      }
      setPreflightJob(job);
      while (["queued", "running", "cancelling"].includes(job.status)) {
        await new Promise((resolve) => window.setTimeout(resolve, 250));
        if (preflightGeneration.current !== generation) {
          void window.archiveLens.tasks.cancelPreflight(job.preflight_id).catch(() => undefined);
          return;
        }
        job = await window.archiveLens.tasks.getPreflight(job.preflight_id);
        if (preflightGeneration.current !== generation) {
          void window.archiveLens.tasks.cancelPreflight(job.preflight_id).catch(() => undefined);
          return;
        }
        setPreflightJob(job);
      }
    } catch (nextError: unknown) {
      if (preflightGeneration.current !== generation) return;
      setError(nextError instanceof Error ? nextError.message : "无法完成文件夹预检");
    }
  }

  const cancelPreflight = async () => {
    if (!preflightJob || !["queued", "running", "cancelling"].includes(preflightJob.status)) return;
    try {
      const job = await window.archiveLens.tasks.cancelPreflight(preflightJob.preflight_id);
      setPreflightJob(job);
    } catch (nextError: unknown) {
      setError(nextError instanceof Error ? nextError.message : "无法取消文件夹预检");
    }
  };

  const selectFolder = async () => {
    const selected = await window.archiveLens.dialog.selectFolder();
    if (selected) {
      if (preflightJob && ["queued", "running", "cancelling"].includes(preflightJob.status)) {
        void window.archiveLens.tasks.cancelPreflight(preflightJob.preflight_id).catch(() => undefined);
      }
      setDir(selected);
      setError(null);
      void runPreflight(selected);
    }
  };

  const selectFiles = async (multiple: boolean) => {
    const selected = await window.archiveLens.dialog.selectFiles({ multiple });
    if (!selected?.length) return;
    const candidates = multiple ? [...files, ...selected] : selected.slice(0, 1);
    const deduped = dedupeFiles(candidates);
    setFiles(deduped.files);
    setSelectionNote(deduped.removed > 0 ? `已自动移除 ${deduped.removed} 个重复文件。` : null);
    setError(null);
  };

  const removeFile = (file: string) => {
    setFiles((current) => current.filter((value) => value !== file));
    setSelectionNote(null);
  };

  const start = async () => {
    if (!parsedTask.success) {
      setError(disabledReason || "请检查扫描配置");
      return;
    }
    setBusy(true);
    setError(null);
    let task: Awaited<ReturnType<typeof window.archiveLens.tasks.create>>;
    try {
      task = await window.archiveLens.tasks.create({
        ...taskInput,
        name: buildTaskName(sourceLabel, searchText),
      });
    } catch (nextError: unknown) {
      const message = nextError instanceof Error ? nextError.message : String(nextError);
      setError(message);
      if (message.includes("预检后发生变化")) {
        setPreflightJob(null);
        setPreflightConfirmed(false);
      }
      setBusy(false);
      return;
    }
    try {
      await window.archiveLens.tasks.start(task.task_id);
      nav(`/tasks/${task.task_id}`);
    } catch (nextError: unknown) {
      const message = nextError instanceof Error ? nextError.message : String(nextError);
      nav(`/tasks/${task.task_id}`, { state: { startError: message } });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="al-welcome al-new-scan-page">
      <PageHeader title="新建扫描" description="选择文件夹或文件清单，设置精确检索词并创建本地 OCR 任务。" />
      <div className="al-new-scan-layout">
        <section className="al-new-scan-main">
          <Card className="al-card">
            <Text weight="semibold">步骤 1：确认档案来源</Text>
            <Text className="al-muted">每次创建一个任务。多个文件可来自不同目录；重复文件会自动去重。</Text>
            <div className="al-source-grid" aria-label="档案来源方式" role="radiogroup">
              {SOURCE_OPTIONS.map((option) => (
                <button key={option.id} type="button" className={`al-source-card ${sourceType === option.id ? "selected" : ""}`} role="radio" aria-checked={sourceType === option.id} onClick={() => { if (option.id === "single" && files.length > 1) { setFiles(files.slice(0, 1)); setSelectionNote("已保留第一个文件；单个文件任务只能扫描一个文件。"); } if (option.id !== "folder") { preflightGeneration.current += 1; if (preflightJob && ["queued", "running", "cancelling"].includes(preflightJob.status)) void window.archiveLens.tasks.cancelPreflight(preflightJob.preflight_id).catch(() => undefined); setPreflightJob(null); setPreflightConfirmed(false); } setSourceType(option.id); setError(null); if (option.id === "folder" && dir && !preflightResult) void runPreflight(dir); }}>
                  <strong>{option.title}</strong><span>{option.detail}</span><small>当前可用</small>
                </button>
              ))}
            </div>
          </Card>

          {sourceType === "folder" ? (
            <>
              <Card className="al-card"><Text weight="semibold">步骤 2：选择文件夹</Text><div className="al-field-row"><Input value={dir} readOnly placeholder="点击右侧按钮选择文件夹" aria-label="扫描文件夹" /><Button onClick={() => void selectFolder()}>选择文件夹</Button></div><Text className="al-muted">将递归读取该目录下受支持的档案文件；文件夹扫描不受 200 个文件上限限制，但大任务需要确认。</Text></Card>
              {dir && <Card className="al-card al-preflight-card">
                <div className="al-card-heading-row"><Text weight="semibold">文件夹预检</Text>{preflightJob && ["queued", "running", "cancelling"].includes(preflightJob.status) ? <Button size="small" onClick={() => void cancelPreflight()} disabled={preflightJob.status === "cancelling"}>{preflightJob.status === "cancelling" ? "正在取消…" : "取消预检"}</Button> : <Button size="small" onClick={() => void runPreflight(dir)}>重新预检</Button>}</div>
                {!preflightJob && <Text className="al-muted">正在准备预检…</Text>}
                {preflightJob && ["queued", "running", "cancelling"].includes(preflightJob.status) && <div className="al-preflight-running"><Spinner size="tiny" /><Text>{preflightJob.status === "cancelling" ? "正在取消预检" : "正在分析文件、页数与磁盘空间"}</Text></div>}
                {preflightJob?.status === "cancelled" && <InlineFeedback tone="warning">预检已取消，尚未创建任务。</InlineFeedback>}
                {preflightJob?.status === "failed" && <InlineFeedback>预检失败：{preflightJob.error_message || "未知错误"}</InlineFeedback>}
                {preflightResult && <PreflightSummary result={preflightResult} confirmed={preflightConfirmed} onConfirmed={setPreflightConfirmed} />}
              </Card>}
            </>
          ) : sourceType === "single" ? (
            <Card className="al-card"><Text weight="semibold">步骤 2：选择文件</Text><div className="al-field-row"><Input value={files[0] ?? ""} readOnly placeholder="点击右侧按钮选择一个文件" aria-label="扫描文件" /><Button onClick={() => void selectFiles(false)}>选择文件</Button></div><Text className="al-muted">仅接受一个 {SUPPORTED_SOURCE_FORMAT_LABEL} 文件。图片会校验真实格式、尺寸和页数。</Text></Card>
          ) : (
            <Card className="al-card"><div className="al-card-heading-row"><Text weight="semibold">步骤 2：选择多个文件</Text><Text className="al-muted">{files.length}/{MAX_SOURCE_FILES} 个</Text></div><div className="al-task-actions"><Button onClick={() => void selectFiles(true)}>添加文件</Button><Button disabled={files.length === 0} onClick={() => { setFiles([]); setSelectionNote(null); }}>清空清单</Button></div><Text className="al-muted">支持跨目录和格式混合选择。去重后必须保留 1–{MAX_SOURCE_FILES} 个有效文件。</Text>{files.length > 0 && <div className="al-failure-list" aria-label="已选文件清单">{files.map((file) => <div key={file}><strong title={file}>{sourceBaseName(file)}</strong><span title={file}>{file}</span><Button size="small" onClick={() => removeFile(file)}>移除</Button></div>)}</div>}{selectionNote && <InlineFeedback tone="info">{selectionNote}</InlineFeedback>}</Card>
          )}

          <Card className="al-card"><Text weight="semibold">步骤 3：设置检索词</Text><div className="al-search-input-wrap"><Input value={searchText} onChange={(_, data) => { setSearchText(data.value); setError(null); }} placeholder="输入 1～32 个文字，按 OCR 结果进行精确匹配" aria-label="检索文字或词语" /><span>{Array.from(searchText).length}/32</span></div><Text className="al-muted">支持 1–32 个 Unicode 字符。精确匹配、区分大小写；不支持正则、通配符或跨 OCR 行匹配。</Text>{searchError && <InlineFeedback>{searchError}</InlineFeedback>}</Card>
          {error && <InlineFeedback>创建任务失败：{error}</InlineFeedback>}
        </section>
        <aside className="al-new-scan-aside"><Card className="al-card"><Text weight="semibold">扫描摘要</Text><div className="al-config-summary"><span>来源方式<strong>{SOURCE_OPTIONS.find((option) => option.id === sourceType)?.title}</strong></span><span>扫描范围<strong title={sourceType === "folder" ? dir : undefined}>{sourceLabel}</strong></span>{isFileSource && <span>文件数量<strong>{files.length}/{MAX_SOURCE_FILES}</strong></span>}{sourceType === "folder" && preflightResult && <><span>有效档案<strong>{preflightResult.supported_file_count} 个</strong></span><span>已知页数<strong>{preflightResult.known_pages} 页</strong></span><span>预计任务空间<strong>{formatBytes(preflightResult.estimated_required_disk_bytes)}</strong></span></>}<span>检索词<strong>{searchText || "尚未输入"}</strong></span><span>匹配方式<strong>精确字面匹配</strong></span><span>出处页显示<strong>源文件无损</strong></span><span>上下文<strong>{DIRECTION_LABELS[reviewPreferences.context_direction]} · 每侧 {reviewPreferences.context_radius} 字</strong></span></div><Text className="al-muted">出处页会按源文件无损显示；上下文配置来自“设置”，创建任务后固化。</Text></Card><Card className="al-card al-local-card"><Text weight="semibold">本地处理</Text><Text className="al-muted">扫描文件、OCR 结果、校对备注和导出报告都将保存到本地任务工作区。</Text></Card></aside>
      </div>
      <div className="al-new-scan-footer"><div>{!canStart && <Text id="scan-disabled-reason" className="al-muted">{disabledReason}</Text>}</div><Button appearance="primary" size="large" onClick={() => void start()} disabled={busy || !canStart} aria-describedby={!canStart ? "scan-disabled-reason" : undefined}>{busy ? "正在创建任务…" : "开始扫描"}</Button></div>
    </div>
  );
}
