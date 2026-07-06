$ErrorActionPreference = "Stop"

$workdir = "F:\OCR\.tmp\work"
$workspaceDir = "F:\OCR\.tmp\full_run_v4"
$rootDir = "F:\OCR"
$outputLog = Join-Path $workspaceDir "auto-merge.out.log"

Set-Location $workdir

while ($true) {
    $count = @(Get-ChildItem -LiteralPath $workspaceDir -Recurse -Filter report.json -ErrorAction SilentlyContinue).Count
    Add-Content -LiteralPath $outputLog -Value ((Get-Date -Format s) + " reports=" + $count)
    if ($count -ge 6) {
        break
    }
    Start-Sleep -Seconds 60
}

python report_pipeline.py --merge-only --root-dir $rootDir --workspace-dir $workspaceDir --output-html (Join-Path $rootDir "约字检索报告.html") *>> $outputLog
