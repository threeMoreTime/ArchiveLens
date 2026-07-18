import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBundledNativePaths } from "../src/main/sidecar/paths";

const root = path.resolve(__dirname, "../../..");

describe("完整离线安装包", () => {
  it("生产路径固定指向 resources 内的原生组件", () => {
    const resources = path.join("C:", "Program Files", "ArchiveLens", "resources");
    const native = resolveBundledNativePaths(resources);

    expect(native.tesseractCmd).toBe(path.join(resources, "native", "tesseract", "tesseract.exe"));
    expect(native.tessdataDir).toBe(path.join(resources, "native", "tesseract", "tessdata"));
    expect(native.djvuBinDir).toBe(path.join(resources, "native", "djvulibre"));
  });

  it("打包配置包含运行组件、许可证和 DjVu 对应源码", () => {
    const builder = readFileSync(path.join(root, "apps/desktop/electron-builder.yml"), "utf-8");
    const diagnostics = readFileSync(path.join(root, "apps/desktop/src/renderer/src/pages/DiagnosticsPage.tsx"), "utf-8");
    expect(builder).toContain("to: native/tesseract");
    expect(builder).toContain("to: native/djvulibre");
    expect(builder).toContain("to: licenses");
    expect(builder).toContain("to: sources");
    expect(diagnostics).toContain("ArchiveLens 安装包内置");
    expect(diagnostics).toContain("实际路径");
  });

  it("安装版与 Portable 的本地数据保留合同明确且不在卸载时删除", () => {
    const builder = readFileSync(path.join(root, "apps/desktop/electron-builder.yml"), "utf-8");
    const readme = readFileSync(path.join(root, "README.md"), "utf-8");
    expect(builder).toContain("deleteAppDataOnUninstall: false");
    expect(readme).toContain("安装版与 Portable 默认使用同一 Windows userData");
    expect(readme).toContain("默认以本地明文保存");
  });

  it("锁定每项下载制品并使用无提权 NSIS 提取", () => {
    const lock = JSON.parse(readFileSync(path.join(root, "scripts/native-dependencies.lock.json"), "utf-8"));
    const prepare = readFileSync(path.join(root, "scripts/prepare-native-runtime.ps1"), "utf-8");
    const engineBuild = readFileSync(path.join(root, "scripts/build-engine.ps1"), "utf-8");

    expect(lock.platform).toBe("win-x64");
    expect(lock.components.tesseract.installer.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(lock.components.djvulibre.source.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(lock.components.tessdata_fast.files).toHaveLength(4);
    expect(lock.components.rapidocr_recognition_model.version).toBe("PP-OCRv6-small");
    expect(lock.components.rapidocr_recognition_model.asset.sha256).toBe(
      "6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884",
    );
    expect(lock.components.rapidocr_recognition_model.asset.size_bytes).toBe(21234383);
    expect(prepare).toContain("7zip-bin-full");
    expect(prepare).toContain("Expand-NsisArchive");
    expect(prepare).toContain("Resolve-CurlExecutable");
    expect(prepare).toContain("[switch]$OcrOnly");
    expect(prepare).toContain("$lock.components.rapidocr_recognition_model");
    expect(prepare).toContain("$rapidocrModel.asset.file_name");
    expect(prepare).toContain('"--proto-redir", "=https"');
    expect(prepare).toContain('Move-Item -LiteralPath $partial -Destination $target -Force');
    expect(prepare).toContain('$djvusedExit = $LASTEXITCODE');
    expect(prepare).toContain('[int]::TryParse($pageCountText, [ref]$pageCount)');
    expect(prepare).not.toContain("Invoke-WebRequest");
    expect(prepare).not.toContain("Start-Process");
    expect(engineBuild).toContain('--add-data "$modelPath;archivelens_models"');
    expect(engineBuild).toContain("--collect-all opencc");
    expect(engineBuild).toContain('"ch_PP-OCRv4_rec_infer.onnx"');
    expect(engineBuild).toContain("Expected exactly one packaged unified OCR model");
  });

  it("发布 CI 使用无宿主 PATH 的全格式离线冒烟", () => {
    const workflow = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf-8");
    const smoke = readFileSync(path.join(root, "scripts/offline-native-smoke.py"), "utf-8");

    expect(workflow).toContain("Run bundled native offline smoke");
    expect(workflow).toContain("offline-native-smoke.py");
    expect(smoke).toContain('"PATH": str(Path(system_root) / "System32")');
    expect(smoke).toContain('"chi_sim_vert"');
    expect(smoke).toContain('"chi_tra_vert"');
  });
});
