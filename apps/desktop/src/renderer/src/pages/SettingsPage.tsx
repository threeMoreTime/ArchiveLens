import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Card, Text } from "@fluentui/react-components";
import type { TaskSummary } from "../../../preload/api";
import { InlineFeedback, LoadingState, PageHeader } from "../components/feedback";
import { ReviewHighlightSettings, type HighlightTaskOption } from "../components/ReviewHighlightSettings";
import { ScriptSearchSettings } from "../components/ScriptSearchSettings";
import { taskDisplayName } from "../utils/presentation";

interface SettingsPageProps {
  currentTaskId: string | null;
}

async function loadAllTasks(): Promise<TaskSummary[]> {
  const items: TaskSummary[] = [];
  let offset = 0;
  let total = 1;
  while (offset < total) {
    const page = await window.archiveLens.tasks.list({ limit: 100, offset });
    items.push(...page.items);
    total = page.total;
    if (page.items.length === 0) break;
    offset += page.items.length;
  }
  return items;
}

export default function SettingsPage({ currentTaskId }: SettingsPageProps) {
  const nav = useNavigate();
  const [tasks, setTasks] = useState<HighlightTaskOption[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [taskError, setTaskError] = useState("");

  useEffect(() => {
    let active = true;
    setLoadingTasks(true);
    setTaskError("");
    loadAllTasks().then((items) => {
      if (!active) return;
      setTasks(items.map((task) => ({
        taskId: task.task_id,
        label: `${taskDisplayName(task)} · ${task.source_label || task.source_dir || "来源未知"} · 检索“${task.search_text}”`,
      })));
    }).catch((error: unknown) => {
      if (active) setTaskError(`任务列表加载失败：${error instanceof Error ? error.message : "请稍后重试"}`);
    }).finally(() => {
      if (active) setLoadingTasks(false);
    });
    return () => { active = false; };
  }, []);

  return (
    <div className="al-welcome al-settings-page">
      <PageHeader title="设置" description="集中管理 ArchiveLens 的显示偏好和本地运行环境入口。" />

      <div className="al-settings-layout">
        <main className="al-settings-main">
          <Card className="al-card al-settings-section">
            <div className="al-settings-section-heading">
              <div><Text weight="semibold" size={500}>简繁字形检索</Text><Text className="al-muted">设置任务内重复搜索默认只命中简体、繁体，或两者都命中。</Text></div>
            </div>
            <ScriptSearchSettings />
          </Card>
          <Card className="al-card al-settings-section">
            <div className="al-settings-section-heading">
              <div><Text weight="semibold" size={500}>校对显示与扫描上下文</Text><Text className="al-muted">出处页按源文件无损显示；可设置命中高亮及横排或竖排档案的上下文阅读顺序。</Text></div>
            </div>
            {taskError && <InlineFeedback tone="warning">{taskError}。全局设置仍可正常修改。</InlineFeedback>}
            {loadingTasks ? <LoadingState label="正在加载任务配置范围…" /> : <ReviewHighlightSettings tasks={tasks} initialTaskId={currentTaskId} />}
          </Card>
        </main>

        <aside className="al-settings-aside">
          <Card className="al-card al-settings-section">
            <Text weight="semibold" size={500}>环境与诊断</Text>
            <Text className="al-muted">检查 OCR 引擎、语言包、文件格式支持和本地工作目录。</Text>
            <Button appearance="primary" onClick={() => nav("/diagnostics")}>打开环境诊断</Button>
          </Card>
          <Card className="al-card al-settings-section al-settings-local-note">
            <Text weight="semibold">本地设置</Text>
            <Text className="al-muted">设置仅保存在本机，不会修改原始文件。简繁范围用于任务内搜索；出处页始终按源文件无损显示；上下文配置会在创建扫描任务时写入新任务。</Text>
          </Card>
        </aside>
      </div>
    </div>
  );
}
