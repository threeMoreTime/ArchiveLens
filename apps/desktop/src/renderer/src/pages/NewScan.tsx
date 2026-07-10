import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Input, Text } from "@fluentui/react-components";
import { TaskCreateParamsSchema } from "@archivelens/ipc-schema";

export default function NewScan() {
  const nav = useNavigate();
  const [dir, setDir] = useState("");
  const [searchText, setSearchText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

      <div className="al-welcome-actions">
        <Button appearance="primary" onClick={start} disabled={busy || !TaskCreateParamsSchema.safeParse({ source_dir: dir, search_text: searchText }).success}>
          {busy ? "创建中…" : "开始扫描"}
        </Button>
      </div>

      {error && <div className="al-error">错误：{error}</div>}
    </div>
  );
}
