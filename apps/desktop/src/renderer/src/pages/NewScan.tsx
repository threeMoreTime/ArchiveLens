import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button, Card, Input, Text } from "@fluentui/react-components";
import {
  MAX_SOURCE_FILES,
  SUPPORTED_SOURCE_FORMAT_LABEL,
  SearchTextSchema,
  TaskCreateParamsSchema,
} from "@archivelens/ipc-schema";
import { InlineFeedback, PageHeader } from "../components/feedback";
import { buildTaskName, sourceBaseName } from "../utils/presentation";

type SourceType = "folder" | "single" | "multiple";

const SOURCE_OPTIONS: Array<{ id: SourceType; title: string; detail: string }> = [
  { id: "folder", title: "整个文件夹", detail: `递归扫描文件夹中的 ${SUPPORTED_SOURCE_FORMAT_LABEL} 档案。` },
  { id: "single", title: "单个文件", detail: `只扫描一个指定的 ${SUPPORTED_SOURCE_FORMAT_LABEL} 文件。` },
  { id: "multiple", title: "多个文件", detail: `将 1–${MAX_SOURCE_FILES} 个指定文件放进同一个任务，可跨目录选择。` },
];

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

export default function NewScan() {
  const nav = useNavigate();
  const location = useLocation();
  const initial = location.state as { sourceDir?: unknown; sourceFiles?: unknown; sourceKind?: unknown } | null;
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
  const searchValidation = SearchTextSchema.safeParse(searchText);
  const searchError = searchText && !searchValidation.success
    ? searchValidation.error.issues[0]?.message ?? "检索词无效"
    : null;
  const isFileSource = sourceType === "single" || sourceType === "multiple";
  const sourceLabel = sourceType === "folder"
    ? (dir || "尚未选择")
    : files.length === 1 ? sourceBaseName(files[0]!) : files.length ? `${files.length} 个已选文件` : "尚未选择";
  const taskInput = sourceType === "folder"
    ? { source_type: "folder" as const, source_dir: dir, search_text: searchText }
    : { source_type: "files" as const, source_files: files, search_text: searchText };
  const parsedTask = TaskCreateParamsSchema.safeParse(taskInput);
  const canStart = parsedTask.success;
  const disabledReason = busy
    ? "正在创建任务，请稍候"
    : sourceType === "folder" && !dir
      ? `请先选择包含 ${SUPPORTED_SOURCE_FORMAT_LABEL} 的文件夹`
      : isFileSource && files.length === 0
        ? "请先选择要扫描的文件"
        : files.length > MAX_SOURCE_FILES
          ? `同一个文件清单任务最多支持 ${MAX_SOURCE_FILES} 个文件`
          : !searchText
            ? "请输入检索文字或词语"
            : searchError || "";

  const selectFolder = async () => {
    const selected = await window.archiveLens.dialog.selectFolder();
    if (selected) {
      setDir(selected);
      setError(null);
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
      setError(nextError instanceof Error ? nextError.message : String(nextError));
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
                <button key={option.id} type="button" className={`al-source-card ${sourceType === option.id ? "selected" : ""}`} role="radio" aria-checked={sourceType === option.id} onClick={() => { if (option.id === "single" && files.length > 1) { setFiles(files.slice(0, 1)); setSelectionNote("已保留第一个文件；单个文件任务只能扫描一个文件。"); } setSourceType(option.id); setError(null); }}>
                  <strong>{option.title}</strong><span>{option.detail}</span><small>当前可用</small>
                </button>
              ))}
            </div>
          </Card>

          {sourceType === "folder" ? (
            <Card className="al-card"><Text weight="semibold">步骤 2：选择文件夹</Text><div className="al-field-row"><Input value={dir} readOnly placeholder="点击右侧按钮选择文件夹" aria-label="扫描文件夹" /><Button onClick={() => void selectFolder()}>选择文件夹</Button></div><Text className="al-muted">将递归读取该目录下受支持的档案文件；文件夹扫描不受 200 个文件上限限制。</Text></Card>
          ) : sourceType === "single" ? (
            <Card className="al-card"><Text weight="semibold">步骤 2：选择文件</Text><div className="al-field-row"><Input value={files[0] ?? ""} readOnly placeholder="点击右侧按钮选择一个文件" aria-label="扫描文件" /><Button onClick={() => void selectFiles(false)}>选择文件</Button></div><Text className="al-muted">仅接受一个 {SUPPORTED_SOURCE_FORMAT_LABEL} 文件。图片会校验真实格式、尺寸和页数。</Text></Card>
          ) : (
            <Card className="al-card"><div className="al-card-heading-row"><Text weight="semibold">步骤 2：选择多个文件</Text><Text className="al-muted">{files.length}/{MAX_SOURCE_FILES} 个</Text></div><div className="al-task-actions"><Button onClick={() => void selectFiles(true)}>添加文件</Button><Button disabled={files.length === 0} onClick={() => { setFiles([]); setSelectionNote(null); }}>清空清单</Button></div><Text className="al-muted">支持跨目录和格式混合选择。去重后必须保留 1–{MAX_SOURCE_FILES} 个有效文件。</Text>{files.length > 0 && <div className="al-failure-list" aria-label="已选文件清单">{files.map((file) => <div key={file}><strong title={file}>{sourceBaseName(file)}</strong><span title={file}>{file}</span><Button size="small" onClick={() => removeFile(file)}>移除</Button></div>)}</div>}{selectionNote && <InlineFeedback tone="info">{selectionNote}</InlineFeedback>}</Card>
          )}

          <Card className="al-card"><Text weight="semibold">步骤 3：设置检索词</Text><div className="al-search-input-wrap"><Input value={searchText} onChange={(_, data) => { setSearchText(data.value); setError(null); }} placeholder="输入 1～32 个文字，按 OCR 结果进行精确匹配" aria-label="检索文字或词语" /><span>{Array.from(searchText).length}/32</span></div><Text className="al-muted">支持 1–32 个 Unicode 字符。精确匹配、区分大小写；不支持正则、通配符或跨 OCR 行匹配。</Text>{searchError && <InlineFeedback>{searchError}</InlineFeedback>}</Card>
          {error && <InlineFeedback>创建任务失败：{error}</InlineFeedback>}
        </section>
        <aside className="al-new-scan-aside"><Card className="al-card"><Text weight="semibold">扫描摘要</Text><div className="al-config-summary"><span>来源方式<strong>{SOURCE_OPTIONS.find((option) => option.id === sourceType)?.title}</strong></span><span>扫描范围<strong title={sourceType === "folder" ? dir : undefined}>{sourceLabel}</strong></span>{isFileSource && <span>文件数量<strong>{files.length}/{MAX_SOURCE_FILES}</strong></span>}<span>检索词<strong>{searchText || "尚未输入"}</strong></span><span>匹配方式<strong>精确字面匹配</strong></span></div></Card><Card className="al-card al-local-card"><Text weight="semibold">本地处理</Text><Text className="al-muted">扫描文件、OCR 结果、校对备注和导出报告都将保存到本地任务工作区。</Text></Card></aside>
      </div>
      <div className="al-new-scan-footer"><div>{!canStart && <Text id="scan-disabled-reason" className="al-muted">{disabledReason}</Text>}</div><Button appearance="primary" size="large" onClick={() => void start()} disabled={busy || !canStart} aria-describedby={!canStart ? "scan-disabled-reason" : undefined}>{busy ? "正在创建任务…" : "开始扫描"}</Button></div>
    </div>
  );
}
