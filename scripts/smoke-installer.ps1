# ArchiveLens NSIS 安装/卸载 smoke（任务 §八）。
# 流程：静默安装 → 验证目录/快捷方式 → 启动 → Sidecar ready → 卸载 → 验证清除。
param(
  [string]$Version = "0.1.0-alpha.11",
  [string]$Setup = (Resolve-Path "$PSScriptRoot/..\apps\desktop\release\ArchiveLens-$Version-x64-setup.exe").Path,
  [string]$InstallDir = "C:\al-install-test",
  [string]$UserData = "C:\al-install-ud"
)
$ErrorActionPreference = "Stop"
Push-Location "$PSScriptRoot/.."
try {
  # 清理旧安装
  $oldUninst = Join-Path $InstallDir "Uninstall ArchiveLens.exe"
  if (Test-Path $oldUninst) { Start-Process -FilePath $oldUninst -ArgumentList "/S" -Wait -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 6
  Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $UserData -ErrorAction SilentlyContinue

  Write-Host ("[INFO] Silent install to {0}" -f $InstallDir)
  # NSIS 静默：/S /D=<绝对路径>（路径不含空格）
  Start-Process -FilePath $Setup -ArgumentList "/S", "/D=$InstallDir" -Wait
  $exe = Join-Path $InstallDir "ArchiveLens.exe"
  if (-not (Test-Path $exe)) { Write-Host ("[FAIL] Install failed: missing {0}" -f $exe) -ForegroundColor Red; exit 1 }
  Write-Host ("[PASS] Install completed: {0}" -f $exe)

  $engine = Join-Path $InstallDir "resources\engine\win-x64\archivelens-engine.exe"
  if (Test-Path $engine) { Write-Host "[PASS] Engine payload present" } else { Write-Host "[FAIL] Engine payload missing" -ForegroundColor Red; exit 1 }

  # 开始菜单快捷方式
  $startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\ArchiveLens.lnk"
  if (Test-Path $startMenu) { Write-Host "[PASS] Start menu shortcut present" } else { Write-Host "[WARN] Start menu shortcut not found" -ForegroundColor Yellow }

  # 启动安装后应用
  Write-Host "[INFO] Launch installed application"
  $previousUserData = $env:ARCHIVELENS_USER_DATA_DIR
  $env:ARCHIVELENS_USER_DATA_DIR = $UserData
  Start-Process -FilePath $exe
  if ($null -eq $previousUserData) { Remove-Item Env:ARCHIVELENS_USER_DATA_DIR -ErrorAction SilentlyContinue }
  else { $env:ARCHIVELENS_USER_DATA_DIR = $previousUserData }
  $logFile = Join-Path $UserData "logs\app.log"
  $ok = $false
  for ($i = 0; $i -lt 35; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Path $logFile) {
      $c = Get-Content $logFile -Raw -ErrorAction SilentlyContinue
      if ($c -match "Sidecar 就绪") { $ok = $true; break }
    }
  }
  Stop-Process -Name "ArchiveLens", "archivelens-engine" -Force -ErrorAction SilentlyContinue
  if ($ok) { Write-Host "[PASS] Installed application started and sidecar became ready" -ForegroundColor Green }
  else { Write-Host "[FAIL] Installed application did not become ready" -ForegroundColor Red; exit 1 }

  # 卸载
  Write-Host "[INFO] Silent uninstall"
  Start-Process -FilePath $oldUninst -ArgumentList "/S" -Wait -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 8
  if (Test-Path $exe) { Write-Host "[WARN] EXE still exists after uninstall" -ForegroundColor Yellow }
  else { Write-Host "[PASS] Uninstall removed program files" -ForegroundColor Green }
} finally {
  Stop-Process -Name "ArchiveLens", "archivelens-engine" -Force -ErrorAction SilentlyContinue
  Pop-Location
}
