import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isAllowedAppNavigation } from "../src/main/security/navigation";

describe("Renderer navigation boundary", () => {
  it("生产环境只允许入口 file URL，不允许任意本地或远程地址", () => {
    const entry = "file:///C:/ArchiveLens/resources/app.asar/out/renderer/index.html";
    expect(isAllowedAppNavigation(entry, entry)).toBe(true);
    expect(isAllowedAppNavigation(`${entry}?task=1#review`, entry)).toBe(true);
    expect(isAllowedAppNavigation("file:///C:/ArchiveLens/resources/app.asar/secret.txt", entry)).toBe(false);
    expect(isAllowedAppNavigation("https://example.com/", entry)).toBe(false);
    expect(isAllowedAppNavigation("file:///C:/ArchiveLens/resources/app.asar/out/renderer/index.html", "")).toBe(false);
  });

  it("开发环境只允许同源地址，拒绝主机前缀和端口混淆", () => {
    const entry = "http://localhost:5173/";
    expect(isAllowedAppNavigation("http://localhost:5173/settings", entry)).toBe(true);
    expect(isAllowedAppNavigation("http://localhost:5173.evil.example/settings", entry)).toBe(false);
    expect(isAllowedAppNavigation("http://localhost:5174/settings", entry)).toBe(false);
    expect(isAllowedAppNavigation("not a url", entry)).toBe(false);
  });
});

describe("Production Renderer CSP", () => {
  it("禁止动态脚本求值、外网与开发服务器连接", () => {
    const html = readFileSync(resolve(__dirname, "../src/renderer/index.html"), "utf-8");
    expect(html).toContain("script-src 'self'; connect-src 'self'");
    expect(html).toContain("object-src 'none'");
    expect(html).not.toContain("unsafe-eval");
    expect(html).not.toContain("localhost:*");
  });
});

describe("开发者 DevTools 与日志门禁", () => {
  const appHandlers = readFileSync(resolve(__dirname, "../src/main/ipc/app.ts"), "utf-8");
  const mainWindow = readFileSync(resolve(__dirname, "../src/main/windows/main.ts"), "utf-8");

  it("DevTools 与日志入口均先校验开发者模式", () => {
    expect(appHandlers).toContain('ipcMain.handle("app.openRendererDevTools"');
    expect(appHandlers).toContain("BrowserWindow.fromWebContents(event.sender)");
    expect(appHandlers).toContain('mode: "detach"');
    expect(appHandlers).toContain('title: "ArchiveLens 开发者工具"');
    // openDevTools 与 openLogDirectory 前必须调用门禁
    const devtoolsSection = appHandlers.slice(appHandlers.indexOf('"app.openRendererDevTools"'));
    expect(devtoolsSection).toContain("await requireDeveloperMode()");
    const logsSection = appHandlers.slice(appHandlers.indexOf('"app.openLogDirectory"'));
    expect(logsSection.slice(0, 200)).toContain("await requireDeveloperMode()");
  });

  it("完整复制与 AI 调试复制受门禁保护，脱敏复制不受限", () => {
    const fullSection = appHandlers.slice(appHandlers.indexOf('"app.copyDiagnosticSummary"'));
    expect(fullSection).toContain('parsed.mode === "full") await requireDeveloperMode()');
    const aiSection = appHandlers.slice(appHandlers.indexOf('"app.copyAiDebugInfo"'), appHandlers.indexOf('"app.openRendererDevTools"'));
    expect(aiSection).toContain("await requireDeveloperMode()");
  });

  it("生产环境仍拦截 F12 与 Ctrl+Shift+I", () => {
    expect(mainWindow).toContain("before-input-event");
    expect(mainWindow).toContain('input.key === "F12"');
    expect(mainWindow).toContain('input.control && input.shift && input.key.toLowerCase() === "i"');
    expect(mainWindow).toContain('!process.env["AL_DEBUG"] && !DEV_SERVER_URL');
  });
});
