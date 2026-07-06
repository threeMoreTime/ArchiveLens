$ErrorActionPreference = "Stop"

$workdir = "F:\OCR\.tmp\work"
$workspaceDir = "F:\OCR\.tmp\full_run_v4"
$rootDir = "F:\OCR"
$workerDir = Join-Path $workspaceDir "worker_06"
$checkpoint = Get-ChildItem (Join-Path $workerDir "run") -Filter "checkpoint-*.json" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $checkpoint) {
    throw "No worker_06 checkpoint found."
}

$payload = Get-Content -Raw $checkpoint.FullName | ConvertFrom-Json
$start = [int]$payload.next_page_index
$end = [int]$payload.document_page_count
$remaining = $end - $start
if ($remaining -le 0) {
    throw "worker_06 has no remaining pages to shard."
}

$shardCount = if ($remaining -ge 1200) { 4 } elseif ($remaining -ge 600) { 3 } else { 2 }
$chunk = [int][Math]::Ceiling($remaining / $shardCount)
$pythonExe = (python -c "import sys; print(sys.executable)").Trim()
$includePath = Join-Path $rootDir $payload.relative_path

Get-CimInstance Win32_Process |
    Where-Object {
        $_.CommandLine -match [regex]::Escape("report_pipeline.py") -and
        $_.CommandLine -match [regex]::Escape("$workerDir") -and
        $_.CommandLine -notmatch [regex]::Escape("worker_06a") -and
        $_.CommandLine -notmatch [regex]::Escape("worker_06b") -and
        $_.CommandLine -notmatch [regex]::Escape("worker_06c") -and
        $_.CommandLine -notmatch [regex]::Escape("worker_06d")
    } |
    ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force
    }

for ($index = 0; $index -lt $shardCount; $index++) {
    $suffix = [char]([int][char]'a' + $index)
    $shardName = "worker_06$suffix"
    $shardDir = Join-Path $workspaceDir $shardName
    $shardStart = $start + ($index * $chunk)
    $shardEnd = [Math]::Min($end, $shardStart + $chunk)
    if ($shardStart -ge $shardEnd) {
        continue
    }

    New-Item -ItemType Directory -Force -Path $shardDir | Out-Null
    $outLog = Join-Path $shardDir "worker.out.log"
    $errLog = Join-Path $shardDir "worker.err.log"
    $cmd = "& { Set-Location '$workdir'; & '$pythonExe' 'report_pipeline.py' '--root-dir' '$rootDir' '--workspace-dir' '$shardDir' '--output-html' '$shardDir\partial.html' '--include-path' '$includePath' '--start-page-index' '$shardStart' '--end-page-index-exclusive' '$shardEnd' 1>> '$outLog' 2>> '$errLog' }"
    Start-Process powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $cmd) -WindowStyle Hidden | Out-Null
    Write-Host "Started $shardName pages [$shardStart, $shardEnd)"
}
