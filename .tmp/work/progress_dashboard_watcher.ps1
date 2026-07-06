$ErrorActionPreference = "Stop"

$workdir = "F:\OCR\.tmp\work"
$workspaceDir = "F:\OCR\.tmp\full_run_v4"
$outputHtml = Join-Path $workspaceDir "scan-progress.html"
$outputLog = Join-Path $workspaceDir "progress-dashboard.out.log"
$errorLog = Join-Path $workspaceDir "progress-dashboard.err.log"

Set-Location $workdir

while ($true) {
    try {
        python progress_dashboard.py --workspace-dir $workspaceDir --output-html $outputHtml --refresh-seconds 20 *>> $outputLog
    } catch {
        $_ | Out-String | Add-Content -LiteralPath $errorLog
    }
    Start-Sleep -Seconds 20
}
