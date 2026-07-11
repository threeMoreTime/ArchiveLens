import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Card, Text } from "@fluentui/react-components";
import type { EngineExitInfo, EnvironmentInfo } from "../../../preload/api";

export default function Welcome() {
  const nav = useNavigate();
  const [checks, setChecks] = useState<{ label: string; status: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.archiveLens.app
      .getEnvironment()
      .then((env: EnvironmentInfo) => {
        setChecks(env.engine?.checks ?? []);
        if (env.startupError) setError(`${env.startupError.code}: ${env.startupError.message}`);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    return window.archiveLens.subscribe.onEngineExit((info: EngineExitInfo) => {
      if (!info.expected) setError(`ENGINE_CRASHED: Engine 已退出（${info.kind}）`);
    });
  }, []);

  const tryDemo = async () => {
    setBusy(true);
    setError(null);
    try {
      const demo = await window.archiveLens.demo.create();
      nav(`/review/${demo.task_id}`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="al-welcome">
      <h1>欢迎使用 ArchiveLens</h1>
      <Text className="al-subtitle">
        在本机扫描 PDF、DJVU、DJV 文件，定位你指定的文字或词语。文档内容不会上传到网络。
      </Text>

      <div className="al-welcome-actions">
        <Button appearance="primary" size="large" onClick={tryDemo} disabled={busy}>
          {busy ? "正在准备示例…" : "体验示例"}
        </Button>
        <Button size="large" onClick={() => nav("/scan/new")}>
          扫描文件夹
        </Button>
      </div>

      {error && <div className="al-error">错误：{error}</div>}

      <Card className="al-env-card">
        <Text weight="semibold">环境摘要</Text>
        <div className="al-env-list">
          {checks.length === 0 && !error && <Text className="al-muted">检测中…</Text>}
          {checks.map((c) => (
            <div className="al-env-row" key={c.label}>
              <span>{c.label}</span>
              <span className={`al-badge al-badge-${c.status}`}>{c.status}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
