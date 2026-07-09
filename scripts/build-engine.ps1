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
  Write-Host "==> 构建 ArchiveLens Engine (PyInstaller one-folder)" -ForegroundColor Cyan
  Write-Host "    Root:   $Root"
  Write-Host "    Output: $OutDir"

  # --collect-all 确保 RapidOCR / onnxruntime 的模型与原生 DLL 纳入打包审计（§二十六.3）。
  pyinstaller `
    --name archivelens-engine `
    --noconfirm `
    --clean `
    --onedir `
    --collect-all rapidocr_onnxruntime `
    --collect-all onnxruntime `
    --collect-all pypdfium2 `
    --hidden-import pytesseract `
    --distpath "$Root/dist/engine/_build" `
    --workpath "$Root/build/engine" `
    "$Root/engine/src/archivelens_engine/__main__.py"
  if ($LASTEXITCODE -ne 0) { throw "PyInstaller 失败（exit $LASTEXITCODE）" }

  # 规范化为 sidecar 期望的 win-x64 路径。
  if (Test-Path $OutDir) { Remove-Item $OutDir -Recurse -Force }
  New-Item -ItemType Directory -Force -Path (Split-Path $OutDir) | Out-Null
  Move-Item "$Root/dist/engine/_build/archivelens-engine" $OutDir

  $exe = Join-Path $OutDir "archivelens-engine.exe"
  if (-not (Test-Path $exe)) { throw "未找到产物：$exe" }

  $pythonVersion = (& python -c "import platform; print(platform.python_version())").Trim()
  node "$Root/scripts/write-build-metadata.mjs" engine "$OutDir/app.info.json" --python-version $pythonVersion
  if ($LASTEXITCODE -ne 0) { throw "写入 engine app.info 失败（exit $LASTEXITCODE）" }

  $sizeMb = [math]::Round((Get-ChildItem $OutDir -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB, 1)
  Write-Host ("==> Engine 构建完成：{0} ({1} MB)" -f $exe, $sizeMb) -ForegroundColor Green
}
finally {
  Pop-Location
}
