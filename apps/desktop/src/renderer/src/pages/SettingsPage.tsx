import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Card, Text } from "@fluentui/react-components";
import type { LocalDataSummary, TaskSummary } from "../../../preload/api";
import { InlineFeedback, LoadingState, PageHeader } from "../components/feedback";
import { ReviewHighlightSettings, type HighlightTaskOption } from "../components/ReviewHighlightSettings";
import { ScriptSearchSettings } from "../components/ScriptSearchSettings";
import { taskDisplayName } from "../utils/presentation";

interface SettingsPageProps {
  currentTaskId: string | null;
}

function formatDataSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0]!;
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index]!;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请稍后重试";
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
  const [localData, setLocalData] = useState<LocalDataSummary | null>(null);
  const [localDataLoading, setLocalDataLoading] = useState(true);
  const [localDataError, setLocalDataError] = useState("");
  const [cleanupConfirming, setCleanupConfirming] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [cleanupFeedback, setCleanupFeedback] = useState("");

  const loadLocalData = useCallback(async () => {
    setLocalDataLoading(true);
    setLocalDataError("");
    try {
      setLocalData(await window.archiveLens.app.getLocalDataSummary());
    } catch (error) {
      setLocalDataError(`本地数据占用读取失败：${errorMessage(error)}`);
    } finally {
      setLocalDataLoading(false);
    }
  }, []);

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

  useEffect(() => { void loadLocalData(); }, [loadLocalData]);

  const openUserData = async () => {
    setLocalDataError("");
    try {
      await window.archiveLens.app.openUserDataDirectory();
    } catch (error) {
      setLocalDataError(`无法打开本地数据目录：${errorMessage(error)}`);
    }
  };

  const openLogs = async () => {
    setLocalDataError("");
    try {
      await window.archiveLens.app.openLogDirectory();
    } catch (error) {
      setLocalDataError(`无法打开日志目录：${errorMessage(error)}`);
    }
  };

  const openTaskData = async (taskId: string) => {
    setLocalDataError("");
    try {
      await window.archiveLens.tasks.openDirectory(taskId);
    } catch (error) {
      setLocalDataError(`无法打开任务目录：${errorMessage(error)}`);
    }
  };

  const cleanupTemporaryData = async () => {
    if (!cleanupConfirming) {
      setCleanupConfirming(true);
      setCleanupFeedback("");
      return;
    }
    setCleaning(true);
    setLocalDataError("");
    try {
      const result = await window.archiveLens.app.cleanupTemporaryData();
      setCleanupFeedback(
        `已尝试 ${result.attempted} 项：清理完成 ${result.completed} 项，失败 ${result.failed} 项，仍待处理 ${result.remaining} 项。${result.skipped_active ? ` 已跳过 ${result.skipped_active} 个运行中导出。` : ""}`,
      );
      setCleanupConfirming(false);
      await loadLocalData();
    } catch (error) {
      setLocalDataError(`临时残留清理失败：${errorMessage(error)}`);
    } finally {
      setCleaning(false);
    }
  };

  const taskLabels = new Map(tasks.map((task) => [task.taskId, task.label]));

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
          <Card className="al-card al-settings-section al-local-data-section">
            <div className="al-settings-section-heading">
              <div><Text weight="semibold" size={500}>本地数据与隐私</Text><Text className="al-muted">ArchiveLens 不上传档案，但数据库、OCR 原文、索引、页面图片、校对备注和导出默认以本地明文保存；本地处理不等于应用级加密。</Text></div>
            </div>
            <InlineFeedback tone="warning">同一 Windows 账户下能读取这些目录的程序也可能读取内容。敏感档案请同时使用 Windows 账户保护与磁盘加密；导出的 HTML/JSON 也应按敏感文件管理。</InlineFeedback>
            <div className="al-inline-actions"><Button appearance="primary" onClick={() => void openUserData()}>打开本地数据目录</Button><Button onClick={() => void openLogs()}>打开日志目录</Button><Button disabled={localDataLoading} onClick={() => void loadLocalData()}>{localDataLoading ? "正在统计…" : "刷新占用"}</Button></div>
            {localDataLoading && !localData && <LoadingState label="正在统计本地数据占用…" />}
            {localDataError && <InlineFeedback>{localDataError}</InlineFeedback>}
            {localData && <>
              <dl className="al-local-data-summary">
                <div><dt>当前可读数据合计</dt><dd>{formatDataSize(localData.total_bytes)}</dd></div>
                <div><dt>数据库（OCR 原文、索引、校对与任务记录）</dt><dd>{formatDataSize(localData.database_bytes)}</dd></div>
                <div><dt>数据库迁移备份（最近 3 份）</dt><dd>{formatDataSize(localData.migration_backup_bytes)}</dd></div>
                <div><dt>任务派生数据（页面图片、crop 等）</dt><dd>{formatDataSize(localData.task_derived_bytes)}</dd></div>
                <div><dt>成功导出</dt><dd>{formatDataSize(localData.export_bytes)}</dd></div>
                <div><dt>导出临时残留</dt><dd>{formatDataSize(localData.temporary_export_bytes)}</dd></div>
                <div><dt>日志 / 设置 / 其他</dt><dd>{formatDataSize(localData.log_bytes + localData.settings_bytes + localData.other_bytes)}</dd></div>
              </dl>
              <Text className="al-muted" title={localData.user_data_path}>位置：{localData.user_data_path}</Text>
              {!localData.complete && <InlineFeedback tone="warning">统计不完整：跳过 {localData.skipped_link_count} 个链接，{localData.unreadable_entry_count} 项无法读取。显示数字仅代表当前可读取内容。</InlineFeedback>}
              <details className="al-local-task-usage">
                <summary>查看各任务占用（{localData.tasks.length}）</summary>
                {localData.tasks.length === 0 ? <Text className="al-muted">当前没有任务派生数据。</Text> : localData.tasks.map((usage) => <div key={usage.task_id}>
                  <span><strong>{taskLabels.get(usage.task_id) ?? usage.task_id}</strong><small>任务数据 {formatDataSize(usage.derived_bytes)} · 导出 {formatDataSize(usage.export_bytes)}</small></span>
                  <Button size="small" onClick={() => void openTaskData(usage.task_id)}>打开目录</Button>
                </div>)}
              </details>
            </>}
            <div className="al-local-cleanup-panel">
              <Text weight="semibold">安全清理导出临时残留</Text>
              <Text className="al-muted">只重试清理数据库已登记且已结束的导出作业专属临时目录；不会删除任务数据库、OCR、校对、成功导出或原始档案。未知孤立目录不会被自动猜测删除。</Text>
              {cleanupConfirming && <InlineFeedback tone="warning">请再次确认。清理后的临时文件不可恢复，但不会影响正式任务数据或已有成功导出。</InlineFeedback>}
              {cleanupFeedback && <InlineFeedback tone="info">{cleanupFeedback}</InlineFeedback>}
              <div className="al-inline-actions"><Button disabled={cleaning} onClick={() => void cleanupTemporaryData()}>{cleaning ? "正在清理…" : cleanupConfirming ? "确认清理安全临时残留" : "清理安全临时残留"}</Button>{cleanupConfirming && <Button disabled={cleaning} onClick={() => setCleanupConfirming(false)}>取消</Button>}</div>
            </div>
            <Text className="al-muted">数据库升级前会自动建立可校验备份并保留最近 3 份；备份同样是本地明文。卸载 ArchiveLens 默认保留本地数据；安装版与 Portable 默认使用同一 Windows userData。删除任务也不是物理介质安全擦除，备份与导出副本需由用户单独管理。</Text>
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
