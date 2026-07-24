import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Button,
  Card,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Text,
} from "@fluentui/react-components";
import type { ClipboardCopyResult, DeveloperSnapshot } from "@archivelens/ipc-schema";
import { InlineFeedback, LoadingState, PageHeader } from "../components/feedback";
import { DiagnosticErrorNotice } from "../components/DiagnosticErrorNotice";
import { toDiagnosticIssue, type DiagnosticIssue } from "../utils/diagnosticIssue";
import { diagnosticStatusLabel } from "../utils/presentation";

interface DeveloperPageProps {
  currentTaskId: string | null;
}

type LoadState = "loading" | "enabled" | "denied";

function formatBytes(bytes: number): string {
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

function readLastOccurrence(taskId: string | null): string | undefined {
  if (!taskId) return undefined;
  try {
    return localStorage.getItem(`archivelens.lastReviewOccurrence.${taskId}`) ?? undefined;
  } catch {
    return undefined;
  }
}

function copyResultMessage(result: ClipboardCopyResult): string {
  const ocr = result.ocr_context_status === "included" ? "是" : "否";
  return `已复制到本机剪贴板：${result.char_count} 字符 · 日志 ${result.log_line_count} 行 · 含 OCR 上下文：${ocr}`;
}

export default function DeveloperPage({ currentTaskId }: DeveloperPageProps) {
  const nav = useNavigate();
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [snapshot, setSnapshot] = useState<DeveloperSnapshot | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [snapshotIssue, setSnapshotIssue] = useState<DiagnosticIssue | null>(null);
  const [copyFeedback, setCopyFeedback] = useState("");
  const [actionError, setActionError] = useState("");
  const [confirm, setConfirm] = useState<"full" | "ai" | null>(null);
  const [copying, setCopying] = useState(false);

  const loadSnapshot = useCallback(async () => {
    setSnapshotLoading(true);
    setSnapshotIssue(null);
    try {
      const snap = await window.archiveLens.app.getDeveloperSnapshot(currentTaskId ? { task_id: currentTaskId } : {});
      setSnapshot(snap);
    } catch (error) {
      setSnapshotIssue(toDiagnosticIssue("ENVIRONMENT_CHECK_FAILED", error));
    } finally {
      setSnapshotLoading(false);
    }
  }, [currentTaskId]);

  useEffect(() => {
    let alive = true;
    window.archiveLens.settings.getDeveloperMode()
      .then(({ enabled }) => {
        if (!alive) return;
        if (!enabled) {
          setLoadState("denied");
          nav("/settings", { replace: true });
          return;
        }
        setLoadState("enabled");
        void loadSnapshot();
      })
      .catch(() => {
        if (!alive) return;
        setLoadState("denied");
        nav("/settings", { replace: true });
      });
    return () => { alive = false; };
  }, [nav, loadSnapshot]);

  const runCopy = useCallback(async (invoke: () => Promise<ClipboardCopyResult>) => {
    setCopying(true);
    setCopyFeedback("");
    setActionError("");
    try {
      setCopyFeedback(copyResultMessage(await invoke()));
    } catch (error) {
      setActionError(`复制失败：${error instanceof Error ? error.message : "请稍后重试"}`);
    } finally {
      setCopying(false);
      setConfirm(null);
    }
  }, []);

  const copyRedacted = () => void runCopy(() => window.archiveLens.app.copyDiagnosticSummary({
    task_id: currentTaskId ?? undefined,
    mode: "redacted",
  }));

  const copyFull = () => void runCopy(() => window.archiveLens.app.copyDiagnosticSummary({
    task_id: currentTaskId ?? undefined,
    mode: "full",
  }));

  const copyAiDebug = () => void runCopy(() => window.archiveLens.app.copyAiDebugInfo({
    task_id: currentTaskId ?? undefined,
    occurrence_id: readLastOccurrence(currentTaskId),
  }));

  const openLogs = async () => {
    setActionError("");
    try {
      await window.archiveLens.app.openLogDirectory();
    } catch (error) {
      setActionError(`无法打开日志目录：${error instanceof Error ? error.message : "请稍后重试"}`);
    }
  };

  const openLocalData = async () => {
    setActionError("");
    try {
      await window.archiveLens.app.openUserDataDirectory();
    } catch (error) {
      setActionError(`无法打开本地数据目录：${error instanceof Error ? error.message : "请稍后重试"}`);
    }
  };

  const openDevTools = async () => {
    setActionError("");
    try {
      await window.archiveLens.app.openRendererDevTools();
    } catch (error) {
      setActionError(`无法打开开发者工具：${error instanceof Error ? error.message : "请稍后重试"}`);
    }
  };

  const exitDeveloperMode = async () => {
    try {
      await window.archiveLens.settings.setDeveloperMode({ enabled: false });
    } catch {
      // 即便持久化失败也返回设置页；Main 门禁以持久化状态为准。
    }
    nav("/settings", { replace: true });
  };

  const rawJson = useMemo(() => (snapshot ? JSON.stringify(snapshot, null, 2) : ""), [snapshot]);

  if (loadState !== "enabled") {
    return <div className="al-welcome al-developer-page"><LoadingState label="正在校验开发者模式…" /></div>;
  }

  const runtime = snapshot?.build_runtime;
  const data = snapshot?.local_data;
  const task = snapshot?.current_task ?? null;

  return (
    <div className="al-welcome al-developer-page">
      <PageHeader title="开发者" description="集中承载技术诊断、路径、版本与调试导出。信息仅在本机呈现或复制到本机剪贴板，不会自动发送。" />

      <div className="al-developer-actions" role="group" aria-label="开发者主操作">
        <Button appearance="primary" disabled={snapshotLoading} onClick={() => void loadSnapshot()}>{snapshotLoading ? "正在重新诊断…" : "重新诊断"}</Button>
        <Button disabled={copying} onClick={copyRedacted}>复制诊断摘要</Button>
        <Button disabled={copying} onClick={() => setConfirm("full")}>复制含完整路径信息</Button>
        <Button disabled={copying} onClick={() => setConfirm("ai")}>复制 AI 错误调试信息</Button>
      </div>
      <div className="al-developer-actions al-developer-actions-secondary" role="group" aria-label="开发者辅助操作">
        <Button size="small" onClick={() => void openLogs()}>打开日志目录</Button>
        <Button size="small" onClick={() => void openLocalData()}>打开本地数据目录</Button>
        <Button size="small" onClick={() => void openDevTools()}>打开渲染器开发者工具</Button>
        <Button size="small" onClick={() => void exitDeveloperMode()}>退出开发者模式</Button>
      </div>
      {copyFeedback && <InlineFeedback tone="info">{copyFeedback}</InlineFeedback>}
      {actionError && <InlineFeedback>{actionError}</InlineFeedback>}
      {snapshotIssue && <DiagnosticErrorNotice issue={snapshotIssue} operation="app.getDeveloperSnapshot" taskId={currentTaskId} onRetry={() => void loadSnapshot()} />}
      {snapshotLoading && !snapshot && <LoadingState label="正在采集诊断快照…" />}

      {snapshot && (
        <div className="al-developer-layout">
          <main className="al-developer-main">
            <Card className="al-card al-developer-section">
              <Text weight="semibold" size={500}>组件与能力检查</Text>
              {snapshot.checks.length === 0 ? <Text className="al-muted">未获取到检查结果。</Text> : (
                <div className="al-developer-checks">
                  {snapshot.checks.map((check) => (
                    <div className="al-developer-check" key={check.key}>
                      <div className="al-developer-check-head">
                        <Text weight="semibold">{check.label}</Text>
                        <span className={`al-badge al-badge-${check.status}`}>{diagnosticStatusLabel(check.status)}</span>
                      </div>
                      <Text className="al-muted">检查 key：{check.key}</Text>
                      {check.detail && <Text className="al-muted">{check.detail}</Text>}
                      {check.impact && <Text className="al-muted">影响：{check.impact}</Text>}
                      {check.remedy && <Text className="al-muted">建议：{check.remedy}</Text>}
                      {check.source && <Text className="al-muted">来源：{check.source}</Text>}
                      {check.path && <Text className="al-muted al-developer-path">路径：{check.path}</Text>}
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card className="al-card al-developer-section">
              <Text weight="semibold" size={500}>当前任务技术状态</Text>
              {task ? (
                <dl className="al-developer-facts">
                  <div><dt>任务 ID</dt><dd>{task.task_id}</dd></div>
                  <div><dt>原始状态</dt><dd>{task.status}</dd></div>
                  <div><dt>workspace</dt><dd className="al-developer-path">{task.workspace_path ?? "未知"}</dd></div>
                  <div><dt>OCR 模型</dt><dd>{task.ocr_model_id ?? "未知"}</dd></div>
                  <div><dt>模型 sha256</dt><dd className="al-developer-path">{task.ocr_model_sha256 ?? "未知"}</dd></div>
                  <div><dt>索引状态</dt><dd>{task.ocr_index_status ?? "未知"} · 已索引 {task.ocr_indexed_pages ?? "?"} 页 · 语料 v{task.ocr_corpus_version ?? "?"}</dd></div>
                  <div><dt>处理进度</dt><dd>{task.processed_pages}/{task.total_pages} · 命中 {task.occurrence_count}</dd></div>
                  <div><dt>版面重建原始状态</dt><dd>{task.layout_rebuild ? JSON.stringify(task.layout_rebuild) : "无"}</dd></div>
                  <div><dt>失败明细</dt><dd>{task.failures.length} 项</dd></div>
                  <div><dt>最近失败导出</dt><dd>{task.last_failed_export ? JSON.stringify(task.last_failed_export) : "无"}</dd></div>
                  <div><dt>匹配该任务的最近错误</dt><dd>{task.last_known_error ? `${task.last_known_error.code} · ${task.last_known_error.message}` : "无"}</dd></div>
                </dl>
              ) : <Text className="al-muted">当前没有选中任务（current_task: null）。</Text>}
            </Card>
          </main>

          <aside className="al-developer-aside">
            <Card className="al-card al-developer-section">
              <Text weight="semibold" size={500}>构建与运行时</Text>
              {runtime && (
                <dl className="al-developer-facts">
                  <div><dt>ArchiveLens</dt><dd>{runtime.app_version}</dd></div>
                  <div><dt>Engine</dt><dd>{runtime.engine_version ?? "未连接"}</dd></div>
                  <div><dt>协议版本</dt><dd>v{runtime.protocol_version}</dd></div>
                  <div><dt>Desktop commit</dt><dd className="al-developer-path">{runtime.desktop_commit ?? "开发构建未记录"}</dd></div>
                  <div><dt>Engine commit</dt><dd className="al-developer-path">{runtime.engine_commit ?? "开发构建未记录"}</dd></div>
                  <div><dt>Electron</dt><dd>{runtime.electron}</dd></div>
                  <div><dt>Chrome</dt><dd>{runtime.chrome}</dd></div>
                  <div><dt>Node</dt><dd>{runtime.node}</dd></div>
                  <div><dt>Python</dt><dd className="al-developer-path">{runtime.python ?? "未知"}</dd></div>
                  <div><dt>平台 / 架构</dt><dd>{runtime.platform} / {runtime.arch}</dd></div>
                  <div><dt>本地识别服务</dt><dd>{runtime.sidecar_status}</dd></div>
                </dl>
              )}
            </Card>

            <Card className="al-card al-developer-section">
              <Text weight="semibold" size={500}>本地路径与数据</Text>
              {data && (
                <dl className="al-developer-facts">
                  <div><dt>userData</dt><dd className="al-developer-path">{data.user_data_path}</dd></div>
                  <div><dt>Engine 数据目录</dt><dd className="al-developer-path">{data.engine_data_path}</dd></div>
                  <div><dt>日志目录</dt><dd className="al-developer-path">{data.log_path}</dd></div>
                  <div><dt>Python 可执行文件</dt><dd className="al-developer-path">{data.python_executable ?? "未知"}</dd></div>
                  <div><dt>合计占用</dt><dd>{formatBytes(data.total_bytes)}{data.complete ? "" : "（统计不完整）"}</dd></div>
                  <div><dt>数据库</dt><dd>{formatBytes(data.database_bytes)}</dd></div>
                  <div><dt>迁移备份</dt><dd>{formatBytes(data.migration_backup_bytes)}</dd></div>
                  <div><dt>任务派生</dt><dd>{formatBytes(data.task_derived_bytes)}</dd></div>
                  <div><dt>导出 / 临时残留</dt><dd>{formatBytes(data.export_bytes)} / {formatBytes(data.temporary_export_bytes)}</dd></div>
                  <div><dt>日志 / 设置 / 其他</dt><dd>{formatBytes(data.log_bytes)} / {formatBytes(data.settings_bytes)} / {formatBytes(data.other_bytes)}</dd></div>
                </dl>
              )}
            </Card>
          </aside>

          {snapshot.collection_errors.length > 0 && (
            <InlineFeedback tone="warning">部分分区采集失败，其余信息仍可用：{snapshot.collection_errors.map((entry) => `${entry.section}（${entry.message}）`).join("；")}</InlineFeedback>
          )}

          <details className="al-developer-raw">
            <summary>原始诊断 JSON（默认折叠，不含日志正文）</summary>
            <pre className="al-developer-raw-pre">{rawJson}</pre>
          </details>
        </div>
      )}

      <Dialog open={confirm === "full"} onOpenChange={(_, changed) => { if (!changed.open) setConfirm(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>复制含完整路径的诊断信息？</DialogTitle>
            <DialogContent>
              <Text>该摘要包含用户名、目录和文件名等本地信息，但不含 OCR 正文与日志。内容只写入本机剪贴板，不会自动发送。</Text>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setConfirm(null)}>取消</Button>
              <Button appearance="primary" disabled={copying} onClick={copyFull}>确认复制</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog open={confirm === "ai"} onOpenChange={(_, changed) => { if (!changed.open) setConfirm(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>复制完整 AI 错误调试信息？</DialogTitle>
            <DialogContent>
              <Text>该内容包含 OCR 正文、用户名、完整路径、文件名、原始错误、调用栈和最近 300 行日志。内容只写入本机剪贴板，不会自动发送，请仅提供给你信任的调试对象。</Text>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setConfirm(null)}>取消</Button>
              <Button appearance="primary" disabled={copying} onClick={copyAiDebug}>确认复制</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
