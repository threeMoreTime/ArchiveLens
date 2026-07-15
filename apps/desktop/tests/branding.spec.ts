import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const desktopRoot = path.resolve(__dirname, "..");

function text(relativePath: string): string {
  return readFileSync(path.join(desktopRoot, relativePath), "utf-8");
}

describe("ArchiveLens 品牌图标", () => {
  it("为安装包、窗口、托盘和侧栏使用统一品牌资源", () => {
    const builder = text("electron-builder.yml");
    const windowSource = text("src/main/windows/main.ts");
    const traySource = text("src/main/tray.ts");
    const appSource = text("src/renderer/src/App.tsx");

    expect(builder).toContain("icon: resources/icon.ico");
    expect(builder).toContain("to: app-icon.png");
    expect(builder).toContain("to: tray-icon.png");
    expect(windowSource).toContain("resolveApplicationIconPath()");
    expect(traySource).toContain("resolveTrayIconPath()");
    expect(traySource).not.toContain("TRAY_ICON_PNG_BASE64");
    expect(appSource).toContain("icon-64.png");
    expect(appSource).toContain('className="al-brand-icon"');
  });

  it("包含有效的 PNG 与 Windows ICO 资源", () => {
    const png = readFileSync(path.join(desktopRoot, "resources/icon.png"));
    const ico = readFileSync(path.join(desktopRoot, "resources/icon.ico"));

    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(1024);
    expect(png.readUInt32BE(20)).toBe(1024);
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBeGreaterThanOrEqual(7);
  });
});
