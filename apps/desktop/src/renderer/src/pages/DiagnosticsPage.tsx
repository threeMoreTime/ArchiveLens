import { useCallback, useEffect, useState } from "react";
import { Button, Card, Text } from "@fluentui/react-components";
import type { AppInfoResult } from "@archivelens/ipc-schema";
import type { EnvironmentInfo } from "../../../preload/api";
import { InlineFeedback, LoadingState, PageHeader } from "../components/feedback";
import { diagnosticStatusLabel } from "../utils/presentation";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "环境诊断失败";
}

export default function DiagnosticsPage() {
  const [environment, setEnvironment] = useState<EnvironmentInfo | null>(null);
  const [appInfo, setAppInfo] = useState<AppInfoResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const runDiagnostics = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [nextEnvironment, nextAppInfo] = await Promise.all([
        window.archiveLens.app.getEnvironment(),
        window.archiveLens.app.getInfo(),
      ]);
      setEnvironment(nextEnvironment);
      setAppInfo(nextAppInfo);
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void runDiagnostics(); }, [runDiagnostics]);

  const openLogs = async () => {
    try {
      await window.archiveLens.app.openLogDirectory();
    } catch (nextError) {
      setError(`无法打开日志目录：${errorMessage(nextError)}`);
    }
  };

  const checks = environment?.engine?.checks ?? [];
  const engineCommit = appInfo?.build_metadata?.git_commit;
  const desktopCommit = appInfo?.desktop_metadata?.git_commit;
  const buildMismatch = Boolean(engineCommit && desktopCommit && engineCommit !== desktopCommit);
  const overall = buildMismatch ? "FAIL" : environment?.engine?.overall ?? (environment?.sidecarReady ? "WARN" : "FAIL");
  const overallLabel = overall === "WARN" ? "部分能力受限" : diagnosticStatusLabel(overall);

  return (
    <div className="al-welcome al-diagnostics-page">
      <PageHeader title="环境诊断" description="检查本地 OCR、文件格式支持、语言包和任务工作目录；诊断不会上传任何档案内容。" />
      <div className="al-diagnostics-actions"><Button appearance="primary" disabled={loading} onClick={() => void runDiagnostics()}>{loading ? "正在重新检查…" : "重新检查"}</Button><Button onClick={() => void openLogs()}>打开日志目录</Button></div>
      {loading && !environment && <LoadingState label="正在检查本地运行环境…" />}
      {error && <InlineFeedback>诊断未完成：{error} <Button size="small" onClick={() => void runDiagnostics()}>重试</Button></InlineFeedback>}

      {environment && (
        <>
          <Card className="al-card al-diagnostics-summary">
            <div><Text weight="semibold" size={500}>当前环境：{overallLabel}</Text><span className={`al-badge al-badge-${overall}`}>{diagnosticStatusLabel(overall)}</span></div>
            <Text className="al-muted">本地识别服务：{environment.sidecarReady ? "已连接" : "未连接"} · ArchiveLens {environment.appVersion} · Windows {environment.arch}</Text>
            {environment.startupError && <InlineFeedback>本地识别服务启动失败：{environment.startupError.message}。请打开日志目录查看详情，修复后重新检查。</InlineFeedback>}
            {buildMismatch && <InlineFeedback>桌面端与 OCR Engine 来自不同代码版本。请停止正式使用并重新安装同一发布包；不要把当前结果作为正式交付依据。</InlineFeedback>}
            {overall !== "PASS" && !environment.startupError && <InlineFeedback tone="warning">部分能力不可用或受限。下方每项均列出实际影响和建议处理方式。</InlineFeedback>}
          </Card>

          <div className="al-diagnostics-list">
            {checks.map((check) => (
              <Card className="al-card al-diagnostic-check" key={check.key}>
                <div className="al-diagnostic-check-heading"><Text weight="semibold">{check.label}</Text><span className={`al-badge al-badge-${check.status}`}>{diagnosticStatusLabel(check.status)}</span></div>
                <Text className="al-muted">{check.detail || "未返回详细信息"}</Text>
                {check.impact ? <div><strong>对你的影响</strong><Text>{check.impact}</Text></div> : <div><strong>对你的影响</strong><Text>当前检查未发现会阻碍使用的问题。</Text></div>}
                {check.remedy && <div><strong>建议处理</strong><Text>{check.remedy}</Text></div>}
              </Card>
            ))}
          </div>

          <Card className="al-card al-diagnostics-runtime">
            <Text weight="semibold">运行时信息</Text>
            <dl><div><dt>Engine</dt><dd>{environment.engine?.engine_version ?? "未连接"}</dd></div><div><dt>Python</dt><dd>{environment.engine?.python_version ?? "—"}</dd></div><div><dt>Electron</dt><dd>{environment.electron}</dd></div><div><dt>Chrome</dt><dd>{environment.chrome}</dd></div><div><dt>Desktop commit</dt><dd>{desktopCommit ?? "开发构建未记录"}</dd></div><div><dt>Engine commit</dt><dd>{engineCommit ?? "开发构建未记录"}</dd></div></dl>
          </Card>
        </>
      )}
    </div>
  );
}
