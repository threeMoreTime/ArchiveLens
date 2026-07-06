$ErrorActionPreference = "Stop"

$workdir = "F:\OCR\.tmp\work"
$workspaceDir = "F:\OCR\.tmp\full_run_v4"
$rootDir = "F:\OCR"
$outputHtml = Join-Path $rootDir "约字检索报告-DJVU阶段版.html"
$outputJson = Join-Path $workspaceDir "run\report-djvu-only.json"

Set-Location $workdir

python report_pipeline.py `
  --merge-only `
  --root-dir $rootDir `
  --workspace-dir $workspaceDir `
  --output-html $outputHtml `
  --output-json $outputJson `
  --merge-workers worker_01 worker_02 worker_03 worker_04 worker_05
