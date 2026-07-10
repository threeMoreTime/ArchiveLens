import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button, Input, Text } from "@fluentui/react-components";
import { SearchTextSchema, TaskCreateParamsSchema } from "@archivelens/ipc-schema";

export default function NewScan() {
  const nav = useNavigate();
  const location = useLocation();
  const initialSourceDir = (location.state as { sourceDir?: unknown } | null)?.sourceDir;
  const [dir, setDir] = useState(typeof initialSourceDir === "string" ? initialSourceDir : "");
  const [searchText, setSearchText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchValidation = SearchTextSchema.safeParse(searchText);
  const searchError = searchText && !searchValidation.success
    ? searchValidation.error.issues[0]?.message ?? "检索词无效"
    : null;
  const canStart = TaskCreateParamsSchema.safeParse({ source_dir: dir, search_text: searchText }).success;

  const select = async () => {
    const d = await window.archiveLens.dialog.selectFolder();
    if (d) setDir(d);
  };

  const start = async () => {
    const parsed = TaskCreateParamsSchema.safeParse({ source_dir: dir, search_text: searchText });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "请输入检索文字或词语");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const t = await window.archiveLens.tasks.create(parsed.data);
      await window.archiveLens.tasks.start(t.task_id);
      nav(`/tasks/${t.task_id}`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="al-welcome">
      <h1>新建扫描</h1>
      <Text className="al-subtitle">选择一个包含 PDF / DJVU / DJV 的本地文件夹。</Text>

      <div className="al-scan-row">
        <Input value={dir} readOnly placeholder="点击右侧按钮选择文件夹" />
        <Button onClick={select}>选择文件夹</Button>
      </div>

      <div className="al-scan-row">
        <Text>检索文字或词语</Text>
        <Input
          value={searchText}
          onChange={(_, data) => setSearchText(data.value)}
          placeholder="输入 1～32 个文字，按 OCR 结果进行精确匹配"
          aria-label="检索文字或词语"
        />
      </div>
      <Text className="al-muted">精确字面匹配，区分大小写，不支持正则、通配符或跨 OCR 行匹配。</Text>
      {searchError && <div className="al-error" role="alert">错误：{searchError}</div>}

      <div className="al-welcome-actions">
        <Button appearance="primary" onClick={start} disabled={busy || !canStart}>
          {busy ? "创建中…" : "开始扫描"}
        </Button>
      </div>

      {error && <div className="al-error">错误：{error}</div>}
    </div>
  );
}
