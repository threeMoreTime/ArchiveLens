import { useEffect, useState } from "react";

/**
 * Phase 2 最小验证页：
 * 1. 调用 window.archiveLens.app.getEnvironment() —— 验证 Preload→Main→Sidecar 全链路；
 * 2. 订阅 Sidecar 事件 —— 验证事件广播；
 * 3. 渲染环境诊断 —— 验证 schema 端到端可用。
 *
 * Phase 4 起替换为完整导航与 Fluent UI 主题。
 */

interface DiagnosticCheck {
  key: string;
  label: string;
  status: "PASS" | "WARN" | "FAIL";
  detail: string;
  impact?: string;
  remedy?: string;
}

interface EnvironmentInfo {
  appVersion: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  sidecarReady: boolean;
  engine: { overall: string; checks: DiagnosticCheck[]; engine_version: string } | null;
}

interface ArchiveLensApi {
  app: {
    getEnvironment(): Promise<EnvironmentInfo>;
    openLogDirectory(): Promise<void>;
  };
  subscribe: {
    onEvent(cb: (event: unknown) => void): () => void;
  };
}

declare global {
  interface Window {
    archiveLens: ArchiveLensApi;
  }
}

export default function App() {
  const [env, setEnv] = useState<EnvironmentInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastEvent, setLastEvent] = useState<string>("（等待事件）");

  useEffect(() => {
    let active = true;
    window.archiveLens.app
      .getEnvironment()
      .then((info) => {
        if (active) setEnv(info);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      });
    const off = window.archiveLens.subscribe.onEvent((event) => {
      const e = event as { event?: string };
      setLastEvent(e.event ?? JSON.stringify(event));
    });
    return () => {
      active = false;
      off();
    };
  }, []);

  return (
    <div className="al-shell">
      <h1>ArchiveLens</h1>
      <p className="al-subtitle">本地档案 OCR 检索与校对工具 — 桌面骨架（Phase 2）</p>

      {error && <div className="al-card al-error">IPC 错误：{error}</div>}

      {env && (
        <>
          <div className="al-card">
            <h2>运行环境</h2>
            <div className="al-meta">
              应用版本 {env.appVersion} · Electron {env.electron} · Chromium {env.chrome} · Node {env.node}
              <br />
              平台 {env.platform} / {env.arch} · Sidecar {env.sidecarReady ? "就绪" : "未就绪"}
            </div>
          </div>

          {env.engine && (
            <div className="al-card">
              <h2>环境诊断（来自 Python Engine）</h2>
              <div className="al-meta">引擎版本 {env.engine.engine_version} · 总体 {env.engine.overall}</div>
              <div className="al-checks" style={{ marginTop: 12 }}>
                {env.engine.checks.map((c) => (
                  <div className="al-check" key={c.key}>
                    <span>
                      {c.label}
                      {c.detail ? ` — ${c.detail}` : ""}
                    </span>
                    <span className={`al-badge al-badge-${c.status}`}>{c.status}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <div className="al-card">
        <h2>Sidecar 事件</h2>
        <div className="al-meta">最近事件：{lastEvent}</div>
      </div>
    </div>
  );
}
