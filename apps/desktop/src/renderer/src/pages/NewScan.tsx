import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button, Card, Input, Text } from "@fluentui/react-components";
import { SearchTextSchema, TaskCreateParamsSchema } from "@archivelens/ipc-schema";
import { InlineFeedback, PageHeader } from "../components/feedback";

type SourceMode = "folder" | "single" | "multiple";

const SOURCE_OPTIONS: Array<{ id: SourceMode; title: string; detail: string; supported: boolean }> = [
  { id: "single", title: "单个文件", detail: "选择一份 PDF、DJVU 或 DJV 档案。", supported: false },
  { id: "multiple", title: "多个文件", detail: "选择多份档案并统一配置检索词。", supported: false },
  { id: "folder", title: "整个文件夹", detail: "递归扫描文件夹中的受支持档案。", supported: true },
];

export default function NewScan() {
  const nav = useNavigate();
  const location = useLocation();
  const initialSourceDir = (location.state as { sourceDir?: unknown } | null)?.sourceDir;
  const [dir, setDir] = useState(typeof initialSourceDir === "string" ? initialSourceDir : "");
  const [sourceMode, setSourceMode] = useState<SourceMode>("folder");
  const [selectedFile, setSelectedFile] = useState("");
  const [searchText, setSearchText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchValidation = SearchTextSchema.safeParse(searchText);
  const searchError = searchText && !searchValidation.success
    ? searchValidation.error.issues[0]?.message ?? "检索词无效"
    : null;
  const canStart = sourceMode === "folder" && TaskCreateParamsSchema.safeParse({ source_dir: dir, search_text: searchText }).success;
  const disabledReason = busy ? "正在创建任务，请稍候" : sourceMode !== "folder" ? "当前版本的任务协议仅支持以文件夹为扫描来源；该来源模式仅用于界面预览。" : !dir ? "请先选择包含 PDF、DJVU 或 DJV 的文件夹" : !searchText ? "请输入检索文字或词语" : searchError ? searchError : "";

  const selectFolder = async () => {
    const selected = await window.archiveLens.dialog.selectFolder();
    if (selected) setDir(selected);
  };
  const selectSingleFile = async () => {
    const selected = await window.archiveLens.dialog.selectFile();
    if (selected) setSelectedFile(selected);
  };
  const start = async () => {
    const parsed = TaskCreateParamsSchema.safeParse({ source_dir: dir, search_text: searchText });
    if (!parsed.success || sourceMode !== "folder") {
      setError(disabledReason || "当前来源模式不能创建任务");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const task = await window.archiveLens.tasks.create(parsed.data);
      await window.archiveLens.tasks.start(task.task_id);
      nav(`/tasks/${task.task_id}`);
    } catch (nextError: unknown) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="al-welcome al-new-scan-page">
      <PageHeader title="新建扫描" description="选择来源、设置精确检索词并创建本地 OCR 任务。数据始终留在此计算机。" />
      <div className="al-new-scan-layout">
        <section className="al-new-scan-main">
          <Card className="al-card"><Text weight="semibold">步骤 1：选择档案来源</Text><Text className="al-muted">当前 Engine 的真实创建链路支持文件夹扫描。单个文件和多个文件保留为明确的界面预览，不会提交伪造任务。</Text><div className="al-source-grid">{SOURCE_OPTIONS.map((option) => <button key={option.id} type="button" className={`al-source-card ${sourceMode === option.id ? "selected" : ""}`} onClick={() => { setSourceMode(option.id); setError(null); }} aria-pressed={sourceMode === option.id}><strong>{option.title}</strong><span>{option.detail}</span><small>{option.supported ? "可创建真实任务" : "界面预览，未接入任务协议"}</small></button>)}</div></Card>

          <Card className="al-card"><Text weight="semibold">步骤 2：选择位置</Text>{sourceMode === "folder" && <div className="al-field-row"><Input value={dir} readOnly placeholder="点击右侧按钮选择文件夹" aria-label="扫描文件夹" /><Button onClick={() => void selectFolder()}>选择文件夹</Button></div>}{sourceMode === "single" && <><div className="al-field-row"><Input value={selectedFile} readOnly placeholder="点击右侧按钮选择单个档案" aria-label="单个档案文件" /><Button onClick={() => void selectSingleFile()}>选择文件</Button></div><InlineFeedback tone="info">已选择的文件仅用于界面预览，当前不会创建或扫描该文件。</InlineFeedback></>}{sourceMode === "multiple" && <InlineFeedback tone="info">多文件原生选择器尚未接入当前任务协议。该卡片完整展示目标 UI，但不会将模拟选择提交给 Engine。</InlineFeedback>}</Card>

          <Card className="al-card"><Text weight="semibold">步骤 3：设置检索词</Text><div className="al-search-input-wrap"><Input value={searchText} onChange={(_, data) => setSearchText(data.value)} placeholder="输入 1～32 个文字，按 OCR 结果进行精确匹配" aria-label="检索文字或词语" /><span>{Array.from(searchText).length}/32</span></div><Text className="al-muted">支持 1–32 个 Unicode 字符。精确匹配、区分大小写；不支持正则、通配符或跨 OCR 行匹配。</Text>{searchError && <InlineFeedback>{searchError}</InlineFeedback>}</Card>
          {error && <InlineFeedback>创建任务失败：{error}</InlineFeedback>}
        </section>
        <aside className="al-new-scan-aside"><Card className="al-card"><Text weight="semibold">扫描摘要</Text><div className="al-config-summary"><span>来源方式<strong>{SOURCE_OPTIONS.find((option) => option.id === sourceMode)?.title}</strong></span><span>扫描范围<strong>{sourceMode === "folder" ? (dir || "尚未选择") : selectedFile || "尚未选择"}</strong></span><span>检索词<strong>{searchText || "尚未输入"}</strong></span><span>匹配方式<strong>精确字面匹配</strong></span></div></Card><Card className="al-card al-local-card"><Text weight="semibold">本地处理</Text><Text className="al-muted">扫描文件、OCR 结果、校对备注和导出报告都将保存到本地任务工作区。</Text></Card></aside>
      </div>
      <div className="al-new-scan-footer"><div>{!canStart && <Text id="scan-disabled-reason" className="al-muted">{disabledReason}</Text>}</div><Button appearance="primary" size="large" onClick={() => void start()} disabled={busy || !canStart} aria-describedby={!canStart ? "scan-disabled-reason" : undefined}>{busy ? "正在创建任务…" : "开始扫描"}</Button></div>
    </div>
  );
}
