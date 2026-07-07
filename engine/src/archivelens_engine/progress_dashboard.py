from __future__ import annotations

import argparse
import json
import textwrap
from datetime import datetime
from pathlib import Path
from typing import Any

from .runtime.worker_state import WorkerState, classify_worker_status, load_worker_state


def _latest_checkpoint(run_dir: Path) -> Path | None:
    checkpoints = sorted(run_dir.glob("checkpoint-*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    return checkpoints[0] if checkpoints else None


def _checkpoint_progress(checkpoint_path: Path) -> dict[str, Any]:
    """从 checkpoint 读取进度字段（不判定状态）。"""
    payload = json.loads(checkpoint_path.read_text(encoding="utf-8"))
    total_pages = int(payload.get("document_page_count") or 0)
    processed_pages = int(payload.get("next_page_index") or 0)
    return {
        "file": payload.get("relative_path", ""),
        "processed_pages": processed_pages,
        "total_pages": total_pages,
        "occurrences_found": len(payload.get("occurrences", [])),
        "failure_count": len(payload.get("failures", [])),
    }


def _load_worker_from_state(worker_dir: Path, state: WorkerState) -> dict[str, Any]:
    """基于显式 WorkerState 综合判定状态（任务 §十二）。"""
    status = classify_worker_status(state, report_completed=False)
    total_pages = state.total_pages
    processed_pages = state.processed_pages
    remaining_pages = max(total_pages - processed_pages, 0)
    progress_pct = round((processed_pages / total_pages) * 100, 2) if total_pages else 0.0
    return {
        "worker": worker_dir.name,
        "file": state.input_file or worker_dir.name,
        "status": status,
        "processed_pages": processed_pages,
        "total_pages": total_pages,
        "remaining_pages": remaining_pages,
        "progress_pct": progress_pct,
        "occurrences_found": state.occurrences_found,
        "failure_count": state.failure_count,
        "updated_at": state.heartbeat_at or state.started_at or "",
    }


def _load_stale_worker(worker_dir: Path, checkpoint_path: Path) -> dict[str, Any]:
    """残留 checkpoint 但无 worker-state：标记 stale，绝不判 running（核心修复）。"""
    progress = _checkpoint_progress(checkpoint_path)
    total_pages = progress["total_pages"]
    processed_pages = progress["processed_pages"]
    return {
        "worker": worker_dir.name,
        "file": progress["file"],
        "status": "stale",
        "processed_pages": processed_pages,
        "total_pages": total_pages,
        "remaining_pages": max(total_pages - processed_pages, 0),
        "progress_pct": round((processed_pages / total_pages) * 100, 2) if total_pages else 0.0,
        "occurrences_found": progress["occurrences_found"],
        "failure_count": progress["failure_count"],
        "updated_at": datetime.fromtimestamp(checkpoint_path.stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
    }


def _load_completed_worker(worker_dir: Path, report_path: Path) -> dict[str, Any]:
    payload = json.loads(report_path.read_text(encoding="utf-8"))
    documents = payload.get("documents", [])
    document = documents[0] if documents else {}
    total_pages = int(document.get("page_count") or 0)
    return {
        "worker": worker_dir.name,
        "file": document.get("relative_path", worker_dir.name),
        "status": "completed",
        "processed_pages": total_pages,
        "total_pages": total_pages,
        "remaining_pages": 0,
        "progress_pct": 100.0 if total_pages else 0.0,
        "occurrences_found": len(payload.get("occurrences", [])),
        "failure_count": len(payload.get("failures", [])),
        "updated_at": datetime.fromtimestamp(report_path.stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
    }


def collect_progress_snapshot(workspace_dir: Path) -> dict[str, Any]:
    workers: list[dict[str, Any]] = []
    for worker_dir in sorted([path for path in workspace_dir.iterdir() if path.is_dir() and path.name.startswith("worker_")]):
        run_dir = worker_dir / "run"
        report_path = run_dir / "report.json"
        checkpoint_path = _latest_checkpoint(run_dir)
        if report_path.exists():
            workers.append(_load_completed_worker(worker_dir, report_path))
            continue
        state_path = worker_dir / "worker-state.json"
        worker_state = load_worker_state(state_path)
        if worker_state is not None:
            workers.append(_load_worker_from_state(worker_dir, worker_state))
        elif checkpoint_path is not None:
            # 残留 checkpoint 无 worker-state：绝不判 running（任务 §十二 核心修复）
            workers.append(_load_stale_worker(worker_dir, checkpoint_path))

    total_pages = sum(worker["total_pages"] for worker in workers)
    processed_pages = sum(worker["processed_pages"] for worker in workers)
    remaining_pages = max(total_pages - processed_pages, 0)
    merge_log = workspace_dir / "auto-merge.out.log"
    merge_log_tail = merge_log.read_text(encoding="utf-8", errors="replace").splitlines()[-12:] if merge_log.exists() else []
    merge_reports_seen = 0
    for line in reversed(merge_log_tail):
        if "reports=" in line:
            try:
                merge_reports_seen = int(line.rsplit("reports=", 1)[1].strip())
                break
            except ValueError:
                continue

    return {
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "workspace_dir": str(workspace_dir),
        "summary": {
            "worker_count": len(workers),
            "completed_workers": sum(1 for worker in workers if worker["status"] == "completed"),
            "running_workers": sum(1 for worker in workers if worker["status"] == "running"),
            "stale_workers": sum(1 for worker in workers if worker["status"] == "stale"),
            "total_pages": total_pages,
            "processed_pages": processed_pages,
            "remaining_pages": remaining_pages,
            "overall_progress_pct": round((processed_pages / total_pages) * 100, 2) if total_pages else 0.0,
            "occurrences_found": sum(worker["occurrences_found"] for worker in workers),
            "failure_count": sum(worker["failure_count"] for worker in workers),
            "merge_reports_seen": merge_reports_seen,
        },
        "workers": workers,
        "merge_log_tail": merge_log_tail,
    }


def build_progress_html(snapshot: dict[str, Any], refresh_seconds: int = 20) -> str:
    data_json = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"))
    return textwrap.dedent(
        f"""\
        <!doctype html>
        <html lang="zh-CN">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <meta http-equiv="refresh" content="{refresh_seconds}">
          <title>扫描实时进度</title>
          <style>
            :root {{
              --bg: #f4efe7;
              --card: #fffdf8;
              --line: #dccfbb;
              --ink: #241b12;
              --accent: #c46916;
              --ok: #2f7d4a;
              --warn: #c57d10;
            }}
            * {{ box-sizing: border-box; }}
            body {{ margin: 0; font-family: "Microsoft YaHei", "PingFang SC", sans-serif; color: var(--ink); background: linear-gradient(180deg, #efe6d4, #fbf8f2); }}
            .shell {{ max-width: 1280px; margin: 0 auto; padding: 20px; }}
            .hero, .panel {{ background: var(--card); border: 1px solid var(--line); border-radius: 18px; padding: 18px 20px; box-shadow: 0 10px 24px rgba(36, 27, 18, 0.06); }}
            .hero {{ display: grid; gap: 12px; }}
            .hero h1 {{ margin: 0; font-size: 32px; }}
            .muted {{ color: #6b5c4a; }}
            .stats {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-top: 12px; }}
            .stat {{ padding: 12px 14px; border-radius: 14px; border: 1px solid var(--line); background: #fffaf0; }}
            .stat strong {{ display: block; font-size: 13px; color: #6f604c; margin-bottom: 6px; }}
            .stat span {{ font-size: 24px; font-weight: 700; }}
            .layout {{ display: grid; grid-template-columns: 1.6fr 1fr; gap: 16px; margin-top: 16px; }}
            table {{ width: 100%; border-collapse: collapse; }}
            th, td {{ text-align: left; padding: 10px 8px; border-bottom: 1px solid #eee2cf; font-size: 14px; vertical-align: top; }}
            th {{ color: #6d5a43; font-weight: 600; }}
            .badge {{ display: inline-block; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; }}
            .badge-running {{ background: #fff1d8; color: var(--warn); }}
            .badge-completed {{ background: #e8f6ec; color: var(--ok); }}
            .progress-wrap {{ min-width: 180px; }}
            .bar {{ height: 10px; border-radius: 999px; background: #efe3d0; overflow: hidden; margin-bottom: 6px; }}
            .bar > div {{ height: 100%; background: linear-gradient(90deg, #d57a1e, #ebb35a); }}
            .log {{ white-space: pre-wrap; font-family: Consolas, monospace; font-size: 13px; background: #fcf8f1; border: 1px solid #eee2cf; border-radius: 12px; padding: 12px; min-height: 260px; }}
            .tip {{ font-size: 13px; color: #6f604c; line-height: 1.6; }}
            @media (max-width: 980px) {{
              .layout {{ grid-template-columns: 1fr; }}
              .hero h1 {{ font-size: 26px; }}
            }}
          </style>
        </head>
        <body>
          <div class="shell">
            <section class="hero">
              <h1>扫描实时进度</h1>
              <div class="muted">此页面每 {refresh_seconds} 秒自动刷新一次。当前快照时间：{snapshot["generated_at"]}</div>
              <div class="muted">工作目录：{snapshot["workspace_dir"]}</div>
              <div class="stats" id="stats"></div>
            </section>
            <div class="layout">
              <section class="panel">
                <h2 style="margin-top:0">Worker 明细</h2>
                <table>
                  <thead>
                    <tr>
                      <th>Worker</th>
                      <th>文件</th>
                      <th>状态</th>
                      <th>进度</th>
                      <th>命中数</th>
                      <th>失败数</th>
                      <th>最近更新</th>
                    </tr>
                  </thead>
                  <tbody id="worker-body"></tbody>
                </table>
              </section>
              <section class="panel">
                <h2 style="margin-top:0">自动合并日志</h2>
                <div id="merge-log" class="log"></div>
                <p class="tip">当这里的 <code>reports=6</code> 出现时，说明 6 个 worker 都已经产出 <code>report.json</code>，随后会自动进入最终 HTML 合并。</p>
              </section>
            </div>
          </div>
          <script>
            const data = {data_json};
            const summary = data.summary;
            const stats = [
              ['总进度', `${{summary.overall_progress_pct}}%`],
              ['已处理页数', `${{summary.processed_pages}} / ${{summary.total_pages}}`],
              ['剩余页数', `${{summary.remaining_pages}}`],
              ['完成 worker', `${{summary.completed_workers}} / ${{summary.worker_count}}`],
              ['运行中 worker', `${{summary.running_workers}}`],
              ['已发现命中', `${{summary.occurrences_found}}`],
              ['失败记录', `${{summary.failure_count}}`],
              ['merge reports', `${{summary.merge_reports_seen}} / ${{summary.worker_count}}`],
            ];
            document.getElementById('stats').innerHTML = stats.map(([label, value]) => `
              <div class="stat">
                <strong>${{label}}</strong>
                <span>${{value}}</span>
              </div>
            `).join('');

            document.getElementById('worker-body').innerHTML = data.workers.map(worker => `
              <tr>
                <td><strong>${{worker.worker}}</strong></td>
                <td>${{worker.file}}</td>
                <td><span class="badge badge-${{worker.status}}">${{worker.status}}</span></td>
                <td class="progress-wrap">
                  <div class="bar"><div style="width:${{worker.progress_pct}}%"></div></div>
                  <div>${{worker.processed_pages}} / ${{worker.total_pages}} (${{worker.progress_pct}}%)</div>
                </td>
                <td>${{worker.occurrences_found}}</td>
                <td>${{worker.failure_count}}</td>
                <td>${{worker.updated_at}}</td>
              </tr>
            `).join('');

            document.getElementById('merge-log').textContent = data.merge_log_tail.join('\\n') || '暂无日志';
          </script>
        </body>
        </html>
        """
    )


def write_progress_html(workspace_dir: Path, output_html: Path, refresh_seconds: int = 20) -> dict[str, Any]:
    snapshot = collect_progress_snapshot(workspace_dir)
    output_html.write_text(build_progress_html(snapshot, refresh_seconds=refresh_seconds), encoding="utf-8")
    return snapshot


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace-dir", required=True)
    parser.add_argument("--output-html", required=True)
    parser.add_argument("--refresh-seconds", type=int, default=20)
    args = parser.parse_args()
    snapshot = write_progress_html(
        workspace_dir=Path(args.workspace_dir),
        output_html=Path(args.output_html),
        refresh_seconds=args.refresh_seconds,
    )
    print(json.dumps(snapshot["summary"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
