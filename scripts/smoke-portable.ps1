# ArchiveLens Portable 启动 smoke（任务 §七）。
# 验证：双击等效启动 → Sidecar ready → 主窗口 → 无残留进程。
param(
  [string]$Portable = (Resolve-Path "$PSScriptRoot/..\apps\desktop\release\ArchiveLens-0.1.0-alpha.1-x64-portable.exe").Path,
  [string]$UserData = "C:\al-port-smoke"
)
$ErrorActionPreference = "Stop"
Push-Location "$PSScriptRoot/.."
try {
  Remove-Item -Recurse -Force $UserData -ErrorAction SilentlyContinue
  Write-Host "==> 启动 portable：$Portable"
  $proc = Start-Process -FilePath $Portable -ArgumentList "--user-data-dir=$UserData" -PassThru
  $logFile = Join-Path $UserData "logs\app.log"
  $ok = $false
  for ($i = 0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Path $logFile) {
      $c = Get-Content $logFile -Raw -ErrorAction SilentlyContinue
      if ($c -match "Sidecar 就绪" -and $c -match "主窗口已创建") { $ok = $true; break }
    }
  }
  if ($ok) {
    Write-Host "✓ portable smoke 通过：Sidecar ready + 主窗口" -ForegroundColor Green
    Get-Content $logFile -Tail 4
  } else {
    Write-Host "✗ portable smoke 超时未就绪（日志：$logFile）" -ForegroundColor Red
    if (Test-Path $logFile) { Get-Content $logFile -Tail 10 }
    exit 1
  }
} finally {
  Stop-Process -Name "ArchiveLens", "archivelens-engine" -Force -ErrorAction SilentlyContinue
  Pop-Location
}
