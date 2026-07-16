# 构建 Python Engine 为 PyInstaller one-folder（任务 §五.3 / §二十七）。
#
# 产物：dist/engine/win-x64/archivelens-engine.exe
# 该目录由 electron-builder 放入 extraResources，运行时经 process.resourcesPath 定位。
#
# 用法：
#   pwsh scripts/build-engine.ps1
#   pwsh scripts/build-engine.ps1 -OutDir dist/engine/win-x64
param(
  [string]$OutDir = "dist/engine/win-x64",
  [string]$Root = (Resolve-Path "$PSScriptRoot/..").Path
)

$ErrorActionPreference = "Stop"
Push-Location $Root
try {
  Write-Host "==> Build ArchiveLens Engine (PyInstaller one-folder)" -ForegroundColor Cyan
  Write-Host "    Root:   $Root"
  Write-Host "    Output: $OutDir"

  $modelName = "PP-OCRv6_rec_small.onnx"
  $modelPath = Join-Path $Root "dist/native/win-x64/rapidocr/$modelName"
  if (-not (Test-Path -LiteralPath $modelPath -PathType Leaf)) {
    throw "Missing locked unified OCR model: $modelPath. Run pnpm prepare:native first."
  }

  # --collect-all 确保 RapidOCR / onnxruntime 的模型与原生 DLL 纳入打包审计（§二十六.3）。
  pyinstaller `
    --name archivelens-engine `
    --noconfirm `
    --clean `
    --onedir `
    --collect-all rapidocr_onnxruntime `
    --collect-all onnxruntime `
    --collect-all opencc `
    --collect-all pypdfium2 `
    --add-data "$modelPath;archivelens_models" `
    --hidden-import pytesseract `
    --distpath "$Root/dist/engine/_build" `
    --workpath "$Root/build/engine" `
    "$Root/engine/src/archivelens_engine/__main__.py"
  if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed (exit $LASTEXITCODE)" }

  # 规范化为 sidecar 期望的 win-x64 路径。
  if (Test-Path $OutDir) { Remove-Item $OutDir -Recurse -Force }
  New-Item -ItemType Directory -Force -Path (Split-Path $OutDir) | Out-Null
  Move-Item "$Root/dist/engine/_build/archivelens-engine" $OutDir

  # RapidOCR wheel 自带的 PP-OCRv4 识别模型不再参与运行；只保留检测、方向
  # 模型和本项目锁定的统一 PP-OCRv6 small 识别模型。
  $legacyRecognitionModels = @(
    Get-ChildItem -LiteralPath $OutDir -Recurse -File -Filter "ch_PP-OCRv4_rec_infer.onnx"
  )
  if ($legacyRecognitionModels.Count -ne 1) {
    throw "Expected exactly one bundled legacy recognition model, found $($legacyRecognitionModels.Count)"
  }
  Remove-Item -LiteralPath $legacyRecognitionModels[0].FullName -Force
  $packagedUnifiedModels = @(
    Get-ChildItem -LiteralPath $OutDir -Recurse -File -Filter $modelName
  )
  if ($packagedUnifiedModels.Count -ne 1) {
    throw "Expected exactly one packaged unified OCR model, found $($packagedUnifiedModels.Count)"
  }

  $exe = Join-Path $OutDir "archivelens-engine.exe"
  if (-not (Test-Path $exe)) { throw "Missing build artifact: $exe" }

  $pythonVersion = (& python -c "import platform; print(platform.python_version())").Trim()
  node "$Root/scripts/write-build-metadata.mjs" engine "$OutDir/app.info.json" --python-version $pythonVersion
  if ($LASTEXITCODE -ne 0) { throw "Failed to write engine app.info (exit $LASTEXITCODE)" }

  $sizeMb = [math]::Round((Get-ChildItem $OutDir -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB, 1)
  Write-Host ("==> Engine build complete: {0} ({1} MB)" -f $exe, $sizeMb) -ForegroundColor Green
}
finally {
  Pop-Location
}
