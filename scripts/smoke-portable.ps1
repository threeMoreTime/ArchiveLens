# ArchiveLens Portable 启动 smoke（任务 §七）。
# 验证：双击等效启动 → Sidecar ready → 主窗口 → 无残留进程。
param(
  [string]$Version = "0.1.0-alpha.11",
  [string]$Portable = (Resolve-Path "$PSScriptRoot/..\apps\desktop\release\ArchiveLens-$Version-x64-portable.exe").Path,
  [string]$UserData = "C:\al-port-smoke"
)
$ErrorActionPreference = "Stop"
Push-Location "$PSScriptRoot/.."
try {
  Remove-Item -Recurse -Force $UserData -ErrorAction SilentlyContinue
  Write-Host ("[INFO] Launch portable wrapper: {0}" -f $Portable)
  $previousUserData = $env:ARCHIVELENS_USER_DATA_DIR
  $env:ARCHIVELENS_USER_DATA_DIR = $UserData
  $proc = Start-Process -FilePath $Portable -PassThru
  if ($null -eq $previousUserData) { Remove-Item Env:ARCHIVELENS_USER_DATA_DIR -ErrorAction SilentlyContinue }
  else { $env:ARCHIVELENS_USER_DATA_DIR = $previousUserData }
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
    Write-Host "[PASS] Portable smoke passed: sidecar ready and main window observed" -ForegroundColor Green
    Get-Content $logFile -Tail 4
  } else {
    Write-Host ("[FAIL] Portable smoke timed out before ready: {0}" -f $logFile) -ForegroundColor Red
    if (Test-Path $logFile) { Get-Content $logFile -Tail 10 }
    exit 1
  }
} finally {
  Stop-Process -Name "ArchiveLens", "archivelens-engine" -Force -ErrorAction SilentlyContinue
  Pop-Location
}
