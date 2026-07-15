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
