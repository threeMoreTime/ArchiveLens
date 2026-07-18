"""Build the self-contained, read-only ArchiveLens HTML review report."""

from __future__ import annotations

import base64
import hashlib
import html
import json
import os
import shutil
import tempfile
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, Callable, Iterable

from PIL import Image

REPORT_SIZE_FIELD_WIDTH = 48


def _format_file_size(size: int) -> str:
    value = float(max(0, size))
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{int(value)} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{size} B"


def _csp_hash(content: str) -> str:
    digest = hashlib.sha256(content.encode("utf-8")).digest()
    return "sha256-" + base64.b64encode(digest).decode("ascii")


def _csp_hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return "sha256-" + base64.b64encode(digest.digest()).decode("ascii")


def _safe_asset_path(workspace_dir: Path | None, relpath: Any) -> Path | None:
    if workspace_dir is None or not relpath:
        return None
    root = workspace_dir.resolve()
    candidate = (root / str(relpath)).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        return None
    return candidate if candidate.is_file() else None


def _encode_page_image(path: Path | None, *, required: bool = False) -> tuple[str, str]:
    if path is None:
        if required:
            raise FileNotFoundError("verified page evidence is missing")
        return "", "页面图片未生成或当前不可用"
    try:
        with Image.open(path) as opened:
            image_format = str(opened.format or "").upper()
            opened.verify()
        mime_type = Image.MIME.get(image_format) or {
            "WEBP": "image/webp",
            "PNG": "image/png",
            "JPEG": "image/jpeg",
            "TIFF": "image/tiff",
        }.get(image_format)
        if not mime_type:
            raise ValueError(f"unsupported report image format: {image_format}")
        return f"data:{mime_type};base64," + base64.b64encode(path.read_bytes()).decode("ascii"), ""
    except (OSError, ValueError) as exc:
        if required:
            raise ValueError(f"verified page evidence is unreadable: {path}") from exc
        return "", "页面图片无法读取，文字识别与校对记录仍可查看"


def _number(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _clamp(value: Any) -> float:
    return min(1.0, max(0.0, _number(value)))


def _human_status(decision: Any) -> tuple[str, str]:
    value = str(decision or "unreviewed")
    labels = {
        "confirmed": "已确认",
        "needs_review": "待复核",
        "rejected": "已拒绝",
        "unreviewed": "未校对",
    }
    return value if value in labels else "unreviewed", labels.get(value, "未校对")


def _safe_file_name(file_name: Any) -> str:
    raw_name = str(file_name or "未命名文件")
    return PurePosixPath(PureWindowsPath(raw_name).name).name or "未命名文件"


def _safe_relative_path(relative_path: Any) -> str | None:
    raw_relative = str(relative_path or "").replace("\\", "/")
    if not raw_relative:
        return None
    windows_path = PureWindowsPath(raw_relative)
    posix_path = PurePosixPath(raw_relative)
    if windows_path.is_absolute() or posix_path.is_absolute() or ".." in posix_path.parts:
        return None
    cleaned = "/".join(part for part in posix_path.parts if part not in ("", "."))
    return cleaned or None


def _serialize_script_value(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return (
        encoded.replace("&", "\\u0026")
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    )


def _source_identity(item: dict[str, Any]) -> str:
    return str(
        item.get("source_id")
        or item.get("document_id")
        or item.get("relative_path")
        or item.get("file_path")
        or item.get("file_name")
        or "unknown-source"
    )


def _register_source(
    item: dict[str, Any],
    files_by_identity: dict[str, dict[str, Any]],
    used_paths: set[str],
) -> dict[str, Any]:
    identity = _source_identity(item)
    if identity in files_by_identity:
        return files_by_identity[identity]
    file_name = _safe_file_name(item.get("file_name"))
    relative_path = _safe_relative_path(item.get("source_display_path") or item.get("relative_path"))
    ordinal_value = item.get("source_ordinal")
    source_order = int(ordinal_value) if isinstance(ordinal_value, int) and ordinal_value >= 0 else len(files_by_identity)
    if not relative_path or relative_path in used_paths:
        relative_path = f"来源-{source_order + 1:03d}/{file_name}"
        suffix = 2
        while relative_path in used_paths:
            relative_path = f"来源-{source_order + 1:03d}-{suffix}/{file_name}"
            suffix += 1
    used_paths.add(relative_path)
    source = {
        "value": f"source-{hashlib.sha256(identity.encode('utf-8')).hexdigest()[:16]}",
        "label": file_name,
        "relativePath": relative_path,
        "sourceOrder": source_order,
    }
    files_by_identity[identity] = source
    return source


def _hit_data(item: dict[str, Any], index: int) -> dict[str, Any]:
    status, status_label = _human_status(item.get("review_decision"))
    x0 = _clamp(item.get("normalized_x0"))
    y0 = _clamp(item.get("normalized_y0"))
    x1 = max(x0, _clamp(item.get("normalized_x1")))
    y1 = max(y0, _clamp(item.get("normalized_y1")))
    sequence_value = int(_number(item.get("global_sequence"), index))
    global_sequence = sequence_value if sequence_value > 0 else index
    return {
        "id": str(item.get("occurrence_id") or f"hit-{index}"),
        "globalSequence": global_sequence,
        "matchedText": str(item.get("matched_text") or item.get("matched_character") or ""),
        "contextBefore": str(item.get("context_before") or ""),
        "contextAfter": str(item.get("context_after") or ""),
        "contextFull": str(item.get("context_full") or ""),
        "confidence": min(1.0, max(0.0, _number(item.get("ocr_confidence")))),
        "status": status,
        "statusLabel": status_label,
        "note": str(item.get("review_note") or ""),
        "box": {"x0": x0, "y0": y0, "x1": x1, "y1": y1},
    }


def _stream_page_data(
    *,
    items: Iterable[dict[str, Any]],
    pages_path: Path,
    workspace_dir: Path | None,
    expected_page_count: int | None,
    progress: Callable[[str, int, int], None] | None,
    page_image_resolver: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
) -> tuple[list[dict[str, Any]], int, int]:
    files_by_identity: dict[str, dict[str, Any]] = {}
    used_paths: set[str] = set()
    page_count = 0
    hit_count = 0
    current_key: tuple[str, int, str] | tuple[str, int] | None = None
    current_page: dict[str, Any] | None = None
    first_page = True

    with pages_path.open("w", encoding="utf-8", newline="") as output:
        def flush_page() -> None:
            nonlocal current_page, first_page, page_count
            if current_page is None:
                return
            if not first_page:
                output.write(",")
            output.write(_serialize_script_value(current_page))
            first_page = False
            page_count += 1
            if progress is not None:
                progress("images", page_count, expected_page_count or page_count)
            current_page = None

        for item in items:
            source = _register_source(item, files_by_identity, used_paths)
            page_number = max(1, int(_number(item.get("page_number"), 1)))
            image_relpath = str(item.get("page_image_relpath") or "")
            key = (
                (_source_identity(item), page_number)
                if page_image_resolver is not None
                else (_source_identity(item), page_number, image_relpath)
            )
            if key != current_key:
                flush_page()
                page_asset = page_image_resolver(item) if page_image_resolver is not None else None
                if page_asset is not None:
                    image_relpath = str(page_asset.get("asset_relpath") or "")
                image_data, image_error = _encode_page_image(
                    _safe_asset_path(workspace_dir, image_relpath),
                    required=page_image_resolver is not None,
                )
                current_key = key
                current_page = {
                    "id": f"page-{page_count + 1}",
                    "sourceId": source["value"],
                    "fileName": source["label"],
                    "relativePath": source["relativePath"],
                    "pageNumber": page_number,
                    "sourceOrder": source["sourceOrder"],
                    "image": image_data,
                    "imageError": image_error,
                    "pixelWidth": int((page_asset or {}).get("pixel_width") or item.get("page_image_width") or 0),
                    "pixelHeight": int((page_asset or {}).get("pixel_height") or item.get("page_image_height") or 0),
                    "hits": [],
                }
            hit_count += 1
            assert current_page is not None
            current_page["hits"].append(_hit_data(item, hit_count))
        flush_page()

    files = [
        {"value": source["value"], "label": source["label"], "relativePath": source["relativePath"]}
        for source in sorted(files_by_identity.values(), key=lambda value: (value["sourceOrder"], value["relativePath"]))
    ]
    return files, page_count, hit_count


REPORT_STYLE = r"""
:root{color-scheme:light;--ink:#172033;--muted:#667085;--line:#e5ded2;--surface:#fff;--soft:#f7f3ec;--brand:#b45309;--highlight:rgba(220,38,38,.18);--danger:#b42318;--success:#067647;--warning:#b54708}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#f2eee7;color:var(--ink);font-family:"Microsoft YaHei","Segoe UI",sans-serif;line-height:1.55}body.modal-open{overflow:hidden}.report{width:min(1440px,100%);margin:0 auto;background:var(--surface);min-height:100vh}.hero{padding:32px clamp(20px,4vw,56px);background:linear-gradient(135deg,#fffaf2,#f4ead9);border-bottom:1px solid var(--line)}.brand-row,.hero-title-row,.toolbar,.card-head,.image-meta,.pager,.modal-head,.modal-actions{display:flex;align-items:center;gap:12px}.brand-row{justify-content:space-between;color:#7a4b13}.brand{font-weight:800;letter-spacing:.02em}.print-button,.secondary-button,.page-button,.modal-button{border:1px solid #cfc6b8;background:#fff;color:var(--ink);border-radius:8px;min-height:38px;padding:8px 14px;cursor:pointer;font:inherit}.print-button:hover,.secondary-button:hover,.page-button:hover,.modal-button:hover{border-color:#9c6b2f;background:#fffaf2}.hero-title-row{align-items:flex-start;justify-content:space-between;margin-top:20px}.hero h1{font-size:clamp(28px,4vw,42px);line-height:1.2;margin:0 0 8px}.report-kind{white-space:nowrap;border-radius:999px;padding:6px 12px;background:#fff;border:1px solid var(--line);font-weight:700}.meta-grid,.stats{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;margin-top:22px}.meta-item,.stat{background:rgba(255,255,255,.8);border:1px solid var(--line);border-radius:10px;padding:12px}.meta-item span,.stat span{display:block;color:var(--muted);font-size:12px}.meta-item strong,.stat strong{display:block;margin-top:3px;font-size:17px;overflow-wrap:anywhere}.integrity{margin:20px clamp(20px,4vw,56px) 0;padding:14px 16px;border-radius:10px;border-left:5px solid var(--success);background:#ecfdf3}.integrity.stage{border-left-color:var(--warning);background:#fffaeb}.content{padding:20px clamp(16px,3vw,44px) 64px}.stats{margin:0 0 18px}.stat{background:var(--soft)}.toolbar{position:sticky;top:0;z-index:8;flex-wrap:wrap;padding:14px;background:rgba(255,255,255,.96);border:1px solid var(--line);border-radius:12px;box-shadow:0 8px 24px rgba(40,30,15,.06)}.control{display:grid;gap:5px;min-width:150px}.control.search{flex:1;min-width:240px}.control label{font-size:12px;color:var(--muted);font-weight:700}.control input,.control select{width:100%;height:40px;border:1px solid #cfc6b8;border-radius:8px;padding:0 11px;background:#fff;color:var(--ink);font:inherit}.result-summary{margin:18px 2px;color:var(--muted)}.result-list{display:grid;gap:20px}.page-card{border:1px solid var(--line);border-radius:14px;background:#fff;overflow:hidden;box-shadow:0 8px 28px rgba(40,30,15,.07);break-inside:avoid}.card-head{justify-content:space-between;padding:16px 18px;background:#faf7f2;border-bottom:1px solid var(--line)}.card-title{min-width:0}.card-title strong{display:block;font-size:17px;overflow-wrap:anywhere}.card-title span{display:block;color:var(--muted);font-size:13px;overflow-wrap:anywhere}.page-summary{white-space:nowrap;color:var(--muted);font-size:13px}.image-button{display:block;width:100%;border:0;background:#e9e4dc;padding:18px;cursor:zoom-in}.image-stage{position:relative;margin:auto;width:min(100%,1400px);line-height:0}.image-stage img{display:block;width:100%;height:auto;background:#fff}.hit-overlay-svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}.hit-overlay-svg rect{fill:var(--highlight)}.image-error{display:grid;place-items:center;min-height:220px;padding:24px;background:#f8f6f1;color:var(--muted);line-height:1.6}.hits{display:grid}.hit{padding:16px 18px;border-top:1px solid var(--line)}.hit:first-child{border-top:0}.hit-head{display:flex;align-items:center;flex-wrap:wrap;gap:9px;margin-bottom:8px}.hit-index{font-weight:800}.match-chip,.status-chip{display:inline-flex;border-radius:999px;padding:3px 9px;font-size:12px;font-weight:700}.match-chip{background:var(--highlight);color:#8b1d1d}.status-chip{background:#f2f4f7;color:#344054}.status-confirmed{background:#ecfdf3;color:#067647}.status-needs_review{background:#fff6ed;color:#b54708}.status-rejected{background:#fef3f2;color:#b42318}.confidence{color:var(--muted);font-size:13px}.context{font-family:"Microsoft YaHei",sans-serif;font-size:15px;overflow-wrap:anywhere}.context mark{background:var(--highlight);color:inherit;padding:0 .08em}.note{margin-top:8px;padding:10px 12px;border-left:3px solid #d6c7b3;background:#faf8f4;color:#475467;white-space:pre-wrap;overflow-wrap:anywhere}.pager{justify-content:center;flex-wrap:wrap;margin-top:24px}.page-button:disabled{opacity:.45;cursor:not-allowed}.page-indicator{min-width:130px;text-align:center}.empty{padding:48px 20px;text-align:center;border:1px dashed #cfc6b8;border-radius:12px;color:var(--muted)}.back-top{position:fixed;right:24px;bottom:24px;z-index:15;border:0;border-radius:999px;padding:11px 16px;background:#7a4b13;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.18);cursor:pointer}.back-top[hidden]{display:none}.modal{position:fixed;inset:0;z-index:30;background:rgba(12,17,29,.88);display:grid;grid-template-rows:auto 1fr auto;color:#fff}.modal[hidden]{display:none}.modal-head{justify-content:space-between;padding:14px 18px;background:rgba(0,0,0,.35)}.modal-stage{overflow:auto;padding:20px;display:grid;place-items:start center}.modal-stage .image-stage{width:min(100%,2400px)}.modal-actions{justify-content:center;padding:14px;background:rgba(0,0,0,.35)}.modal-button{background:#fff}.modal-close{min-width:42px}.sr-only{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media(max-width:900px){.meta-grid,.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.hero-title-row,.card-head{align-items:flex-start;flex-direction:column}.page-summary{white-space:normal}.toolbar{position:static}.control,.control.search{width:100%;min-width:0}}@media print{@page{size:A4 portrait;margin:12mm}body{background:#fff}.report{width:auto}.hero{padding:0 0 8mm;background:#fff}.brand-row{display:block}.print-button,.toolbar,.pager,.back-top,.modal{display:none!important}.content{padding:0}.integrity{margin:5mm 0}.meta-grid,.stats{grid-template-columns:repeat(3,1fr);gap:3mm}.meta-item,.stat{border-color:#bbb;padding:3mm}.result-summary{margin:5mm 0}.result-list{gap:7mm}.page-card{box-shadow:none;border-color:#aaa;break-inside:avoid}.image-button{padding:4mm;background:#fff;cursor:default}.image-stage{max-height:150mm}.image-stage img{max-height:150mm;object-fit:contain}.hit{padding:3mm 4mm}.page-card.print-break{break-before:page}}
/* 命中记录模式：导航和正文共享永久序号，正文严格按出处、文字、原图排列。 */
.review-layout{display:grid;grid-template-columns:320px minmax(0,1fr);gap:20px;align-items:start}.review-layout.nav-collapsed{grid-template-columns:56px minmax(0,1fr)}.record-nav{position:sticky;top:96px;max-height:calc(100vh - 116px);overflow:hidden;border:1px solid var(--line);border-radius:12px;background:#fff;box-shadow:0 8px 28px rgba(40,30,15,.06)}.record-nav-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px;border-bottom:1px solid var(--line);background:#faf7f2}.record-nav-title{margin:0;font-size:16px}.record-nav-toggle{flex:none;min-width:38px;padding:7px 9px}.record-nav-list{max-height:calc(100vh - 178px);overflow:auto;padding:8px}.record-nav-item{display:grid;width:100%;gap:3px;padding:10px;border:0;border-radius:8px;background:transparent;color:var(--ink);font:inherit;text-align:left;cursor:pointer}.record-nav-item:hover,.record-nav-item:focus-visible{background:#fff7ed;outline:2px solid transparent}.record-nav-item+.record-nav-item{border-top:1px solid var(--line)}.record-nav-item strong,.record-nav-path{overflow-wrap:anywhere}.record-nav-path{color:var(--muted);font-size:12px}.record-nav-match{color:#8b1d1d;font-size:13px;font-weight:700}.record-nav-context{display:-webkit-box;overflow:hidden;color:var(--muted);font-size:12px;-webkit-box-orient:vertical;-webkit-line-clamp:2}.nav-collapsed .record-nav-title,.nav-collapsed .record-nav-list{display:none}.result-pane{min-width:0}.occurrence-card.targeted{outline:3px solid #f59e0b;outline-offset:3px;animation:target-pulse 1.8s ease-out}.source-sequence{color:#8b4513}.record-text{padding:18px;border-bottom:1px solid var(--line)}.record-section-title{margin:0 0 10px;font-size:15px}.record-meta{display:flex;align-items:center;flex-wrap:wrap;gap:9px;margin-bottom:10px}@keyframes target-pulse{0%{box-shadow:0 0 0 8px rgba(245,158,11,.25)}100%{box-shadow:0 8px 28px rgba(40,30,15,.07)}}
@media(max-width:900px){.review-layout,.review-layout.nav-collapsed{grid-template-columns:minmax(0,1fr)}.record-nav{position:static;max-height:none}.record-nav-list{max-height:38vh}.nav-collapsed .record-nav-list{display:none}}
@media print{.record-nav,.record-nav-toggle{display:none!important}.review-layout,.review-layout.nav-collapsed{display:block}.occurrence-card{break-inside:avoid}.occurrence-card.print-break{break-before:page}.record-text{padding:3mm 4mm}.image-button{order:3}}
""".strip()


REPORT_SCRIPT = r"""
const STATUS_RANK={unreviewed:0,needs_review:1,rejected:2,confirmed:3};
const state={file:"",status:"",query:"",sort:"sequence",pageSize:20,page:1,printMode:false,printSnapshot:null,filtered:[],modalIndex:-1,navCollapsed:false};
const byId=(id)=>document.getElementById(id);
const el=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=String(text);return node};
const normalized=(value)=>String(value??"").toLocaleLowerCase();
const sequenceLabel=(value)=>`#${String(value).padStart(4,"0")}`;
const ALL_RECORDS=[];
let fallbackSequence=0;
DATA.pages.forEach((page)=>page.hits.forEach((hit)=>{fallbackSequence+=1;const candidate=Number(hit.globalSequence);ALL_RECORDS.push({page,hit,sequence:Number.isSafeInteger(candidate)&&candidate>0?candidate:fallbackSequence,ordinal:fallbackSequence})}));
function hitSearchText(page,hit){return normalized([page.fileName,page.relativePath,hit.matchedText,hit.contextBefore,hit.contextAfter,hit.contextFull,hit.note].join(" "))}
function recordId(record){return `record-${record.sequence}-${record.ordinal}`}
function recordContext(hit){return hit.contextFull||`${hit.contextBefore||""}${hit.matchedText||""}${hit.contextAfter||""}`||hit.matchedText||"无 OCR 上下文"}
function sourceCompare(a,b){return a.page.sourceOrder-b.page.sourceOrder||a.page.pageNumber-b.page.pageNumber||a.sequence-b.sequence}
function filterAndSort(){
  state.filtered=ALL_RECORDS.filter((record)=>{const page=record.page;const hit=record.hit;if(state.file&&page.sourceId!==state.file)return false;if(state.status&&hit.status!==state.status)return false;if(state.query&&!hitSearchText(page,hit).includes(state.query))return false;return true});
  const collator=new Intl.Collator("zh-CN",{numeric:true,sensitivity:"base"});
  const sorters={sequence:(a,b)=>a.sequence-b.sequence||sourceCompare(a,b),source:sourceCompare,fileAsc:(a,b)=>collator.compare(a.page.fileName,b.page.fileName)||sourceCompare(a,b),fileDesc:(a,b)=>collator.compare(b.page.fileName,a.page.fileName)||sourceCompare(a,b),pageAsc:(a,b)=>a.page.pageNumber-b.page.pageNumber||sourceCompare(a,b),pageDesc:(a,b)=>b.page.pageNumber-a.page.pageNumber||sourceCompare(a,b),confidence:(a,b)=>a.hit.confidence-b.hit.confidence||sourceCompare(a,b),status:(a,b)=>(STATUS_RANK[a.hit.status]??0)-(STATUS_RANK[b.hit.status]??0)||sourceCompare(a,b)};
  state.filtered.sort(sorters[state.sort]||sorters.sequence);
  const maxPage=Math.max(1,Math.ceil(state.filtered.length/state.pageSize));if(state.page>maxPage)state.page=maxPage;
}
function overlaySvg(hits){const ns="http:"+"//www.w3.org/2000/svg";const svg=document.createElementNS(ns,"svg");svg.setAttribute("class","hit-overlay-svg");svg.setAttribute("viewBox","0 0 1 1");svg.setAttribute("preserveAspectRatio","none");svg.setAttribute("aria-hidden","true");hits.forEach((hit)=>{const box=hit.box;const rect=document.createElementNS(ns,"rect");rect.setAttribute("x",String(box.x0));rect.setAttribute("y",String(box.y0));rect.setAttribute("width",String(Math.max(0,box.x1-box.x0)));rect.setAttribute("height",String(Math.max(0,box.y1-box.y0)));svg.append(rect)});return svg}
function imageStage(page,hits,modal=false){const stage=el("div","image-stage");if(page.image){const image=el("img");image.src=page.image;image.alt=`${page.fileName} 第 ${page.pageNumber} 页`;if(!modal)image.loading="lazy";stage.append(image,overlaySvg(hits))}else{stage.append(el("div","image-error",page.imageError||"页面图片当前不可用"))}return stage}
function contextNode(hit){const context=el("div","context");const full=recordContext(hit);const matched=String(hit.matchedText||"");const matchIndex=matched?full.indexOf(matched):-1;if(matchIndex>=0){context.append(document.createTextNode(full.slice(0,matchIndex)),el("mark","",matched),document.createTextNode(full.slice(matchIndex+matched.length)))}else{context.textContent=full}return context}
function hitNode(hit){const row=el("section","record-text");row.append(el("h3","record-section-title","OCR 文字与校对信息"));const meta=el("div","record-meta");meta.append(el("span","match-chip",hit.matchedText||"未识别"),el("span",`status-chip status-${hit.status}`,hit.statusLabel),el("span","confidence",`OCR 置信度 ${(hit.confidence*100).toFixed(0)}%`));row.append(meta,contextNode(hit),el("div","note",hit.note?`校对备注：${hit.note}`:"校对备注：无备注"));return row}
function openModal(index){state.modalIndex=index;const record=state.filtered[index];if(!record)return;byId("modal-title").textContent=`${sequenceLabel(record.sequence)} · ${record.page.fileName} · 第 ${record.page.pageNumber} 页`;const host=byId("modal-image");host.replaceChildren(imageStage(record.page,[record.hit],true));byId("modal-prev").disabled=index<=0;byId("modal-next").disabled=index>=state.filtered.length-1;byId("image-modal").hidden=false;document.body.classList.add("modal-open")}
function closeModal(){byId("image-modal").hidden=true;byId("modal-image").replaceChildren();document.body.classList.remove("modal-open");state.modalIndex=-1}
function cardNode(record,index){const page=record.page;const hit=record.hit;const card=el("article","page-card occurrence-card");card.id=recordId(record);if(state.printMode&&index>0)card.classList.add("print-break");const head=el("header","card-head");const title=el("div","card-title");title.append(el("strong","source-sequence",`${sequenceLabel(record.sequence)} · ${page.fileName} · 第 ${page.pageNumber} 页`),el("span","",page.relativePath));head.append(title,el("div","page-summary",`命中：${hit.matchedText||"未识别"}`));const button=el("button","image-button");button.type="button";button.setAttribute("aria-label",`查看 ${sequenceLabel(record.sequence)} 原始页面大图`);button.append(imageStage(page,[hit]));button.addEventListener("click",()=>openModal(index));card.append(head,hitNode(hit),button);return card}
function recordNavItem(record){const button=el("button","record-nav-item");button.type="button";button.title=record.page.relativePath;button.append(el("strong","",`${sequenceLabel(record.sequence)} · ${record.page.fileName} · 第 ${record.page.pageNumber} 页`),el("span","record-nav-match",`命中：${record.hit.matchedText||"未识别"}`),el("span","record-nav-context",recordContext(record.hit)));button.addEventListener("click",()=>navigateToRecord(record));return button}
function renderNavigation(){const host=byId("record-nav-list");host.replaceChildren();state.filtered.forEach((record)=>host.append(recordNavItem(record)));if(!state.filtered.length)host.append(el("p","empty","当前筛选没有命中记录。"))}
function navigateToRecord(record){const index=state.filtered.indexOf(record);if(index<0)return;state.page=Math.floor(index/state.pageSize)+1;renderResults();requestAnimationFrame(()=>{const target=byId(recordId(record));if(!target)return;target.scrollIntoView({behavior:"smooth",block:"start"});target.classList.add("targeted");setTimeout(()=>target.classList.remove("targeted"),1900)})}
function setNavCollapsed(collapsed){state.navCollapsed=Boolean(collapsed);byId("review-layout").classList.toggle("nav-collapsed",state.navCollapsed);const toggle=byId("record-nav-toggle");toggle.setAttribute("aria-expanded",String(!state.navCollapsed));toggle.textContent=state.navCollapsed?"展开":"收起";toggle.setAttribute("aria-label",state.navCollapsed?"展开命中导航":"收起命中导航")}
function renderResults(){filterAndSort();renderNavigation();const pageCount=new Set(state.filtered.map((record)=>record.page.id)).size;byId("result-summary").textContent=`当前显示 ${state.filtered.length} 条命中记录，分布在 ${pageCount} 个页面`;
  const host=byId("result-list");host.replaceChildren();if(!state.filtered.length){host.append(el("div","empty","没有找到符合当前条件的命中记录。请调整搜索词或清除筛选条件。"));renderPager();return}
  const start=state.printMode?0:(state.page-1)*state.pageSize;const end=state.printMode?state.filtered.length:start+state.pageSize;state.filtered.slice(start,end).forEach((record,localIndex)=>host.append(cardNode(record,start+localIndex)));renderPager()
}
function renderPager(){const pages=Math.max(1,Math.ceil(state.filtered.length/state.pageSize));byId("page-indicator").textContent=`第 ${state.page} / ${pages} 页`;byId("first-page").disabled=state.page<=1;byId("prev-page").disabled=state.page<=1;byId("next-page").disabled=state.page>=pages;byId("last-page").disabled=state.page>=pages;byId("pager").hidden=state.printMode||state.filtered.length===0}
function goPage(value){const pages=Math.max(1,Math.ceil(state.filtered.length/state.pageSize));state.page=Math.min(pages,Math.max(1,value));renderResults();byId("results-start").scrollIntoView({behavior:"smooth",block:"start"})}
function populateFiles(){const select=byId("file-filter");DATA.files.forEach((file)=>{const option=el("option","",file.label===file.relativePath?file.label:`${file.label} · ${file.relativePath}`);option.value=file.value;select.append(option)})}
function resetFilters(){state.file="";state.status="";state.query="";state.sort="sequence";state.pageSize=20;state.page=1;byId("file-filter").value="";byId("status-filter").value="";byId("report-search").value="";byId("sort-order").value="sequence";byId("page-size").value="20";renderResults()}
function preparePrint(){if(state.printMode)return;state.printSnapshot={file:state.file,status:state.status,query:state.query,sort:state.sort,pageSize:state.pageSize,page:state.page};state.file="";state.status="";state.query="";state.sort="sequence";state.page=1;state.printMode=true;renderResults()}
function restoreAfterPrint(){if(!state.printMode)return;const saved=state.printSnapshot;state.printMode=false;state.printSnapshot=null;if(saved)Object.assign(state,saved);renderResults()}
let searchTimer=0;
populateFiles();setNavCollapsed(false);renderResults();
byId("record-nav-toggle").addEventListener("click",()=>setNavCollapsed(!state.navCollapsed));
byId("file-filter").addEventListener("change",(event)=>{state.file=event.target.value;state.page=1;renderResults()});
byId("status-filter").addEventListener("change",(event)=>{state.status=event.target.value;state.page=1;renderResults()});
byId("report-search").addEventListener("input",(event)=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{state.query=normalized(event.target.value.trim());state.page=1;renderResults()},180)});
byId("sort-order").addEventListener("change",(event)=>{state.sort=event.target.value;state.page=1;renderResults()});
byId("page-size").addEventListener("change",(event)=>{state.pageSize=Number(event.target.value);state.page=1;renderResults()});
byId("reset-filters").addEventListener("click",resetFilters);byId("first-page").addEventListener("click",()=>goPage(1));byId("prev-page").addEventListener("click",()=>goPage(state.page-1));byId("next-page").addEventListener("click",()=>goPage(state.page+1));byId("last-page").addEventListener("click",()=>goPage(Math.ceil(state.filtered.length/state.pageSize)));
byId("print-report").addEventListener("click",()=>{if(window.confirm(`将打印完整报告，共包含 ${DATA.hitCount} 条命中记录。当前筛选条件不会影响打印内容。`))window.print()});
byId("modal-close").addEventListener("click",closeModal);byId("modal-prev").addEventListener("click",()=>openModal(state.modalIndex-1));byId("modal-next").addEventListener("click",()=>openModal(state.modalIndex+1));
document.addEventListener("keydown",(event)=>{if(byId("image-modal").hidden)return;if(event.key==="Escape")closeModal();if(event.key==="ArrowLeft"&&state.modalIndex>0)openModal(state.modalIndex-1);if(event.key==="ArrowRight"&&state.modalIndex<state.filtered.length-1)openModal(state.modalIndex+1)});
window.addEventListener("beforeprint",preparePrint);window.addEventListener("afterprint",restoreAfterPrint);window.addEventListener("scroll",()=>{byId("back-top").hidden=window.scrollY<500},{passive:true});byId("back-top").addEventListener("click",()=>window.scrollTo({top:0,behavior:"smooth"}));
""".strip()


def _report_metadata(
    *,
    task: dict[str, Any],
    integrity: dict[str, Any],
    exported_at: str,
    files: list[dict[str, Any]],
    page_count: int,
    hit_count: int,
) -> dict[str, Any]:
    review_counts = {
        "confirmed": int(integrity.get("confirmed_count", 0) or 0),
        "needs_review": int(integrity.get("needs_review_count", 0) or 0),
        "rejected": int(integrity.get("rejected_count", 0) or 0),
        "unreviewed": int(integrity.get("unreviewed_count", 0) or 0),
    }
    report_kind = "最终报告" if integrity.get("fully_verified") else "阶段性报告"
    if not integrity.get("scan_complete"):
        integrity_message = "扫描尚未完整完成，结果可能继续增加或存在缺页。"
    elif not integrity.get("review_complete"):
        integrity_message = f"尚有 {review_counts['unreviewed']} 条结果未校对。"
    else:
        integrity_message = "扫描和校对均已完成，报告结果已完整核验。"
    return {
        "title": "ArchiveLens 离线审阅报告",
        "taskName": str(task.get("name") or "未命名任务"),
        "reportKind": report_kind,
        "searchText": str(task.get("search_text") or ""),
        "exportedAt": exported_at,
        "sourceCount": len(files),
        "pageCount": page_count,
        "hitCount": hit_count,
        "reviewCounts": review_counts,
        "scanComplete": bool(integrity.get("scan_complete")),
        "reviewComplete": bool(integrity.get("review_complete")),
        "integrityMessage": integrity_message,
        "files": files,
    }


def _write_script(script_path: Path, pages_path: Path, data: dict[str, Any]) -> None:
    serialized = _serialize_script_value(data)
    if not serialized.endswith("}"):
        raise ValueError("report metadata must serialize as an object")
    with script_path.open("wb") as output:
        output.write(("const DATA=" + serialized[:-1] + ',"pages":[').encode("utf-8"))
        with pages_path.open("rb") as pages:
            shutil.copyfileobj(pages, output, length=1024 * 1024)
        output.write(("]};\n" + REPORT_SCRIPT).encode("utf-8"))


def _document_parts(data: dict[str, Any], *, script_hash: str, report_size_label: str) -> tuple[str, str]:
    csp = "; ".join(
        (
            "default-src 'none'",
            "img-src data:",
            f"style-src '{_csp_hash(REPORT_STYLE)}'",
            f"script-src '{script_hash}'",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-src 'none'",
            "object-src 'none'",
            "connect-src 'none'",
        )
    )
    title = html.escape(f"ArchiveLens 离线审阅报告 — {data['searchText']}", quote=True)
    kind_class = "" if data["reportKind"] == "最终报告" else " stage"
    prefix = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="{html.escape(csp, quote=True)}"><title>{title}</title><style>{REPORT_STYLE}</style></head>
<body><main class="report"><header class="hero"><div class="brand-row"><span class="brand">◆ ArchiveLens</span><button id="print-report" class="print-button" type="button">打印报告</button></div><div class="hero-title-row"><div><h1>离线审阅报告</h1><strong>{html.escape(data['taskName'])}</strong><p class="sr-only">检索词：{html.escape(data['searchText'])}</p></div><span class="report-kind">{data['reportKind']}</span></div><div class="meta-grid"><div class="meta-item"><span>检索词</span><strong>{html.escape(data['searchText'])}</strong></div><div class="meta-item"><span>来源文件</span><strong>{data['sourceCount']} 个</strong></div><div class="meta-item"><span>命中页面</span><strong>{data['pageCount']} 页</strong></div><div class="meta-item"><span>命中记录</span><strong>{data['hitCount']} 条</strong></div><div class="meta-item"><span>导出时间</span><strong>{html.escape(data['exportedAt'])}</strong></div><div class="meta-item"><span>文件大小</span><strong>{report_size_label}</strong></div></div></header>
<aside class="integrity{kind_class}"><strong>{data['reportKind']}</strong>：{html.escape(data['integrityMessage'])}</aside>
<section class="content"><div class="stats" aria-label="校对统计"><div class="stat"><span>命中总数</span><strong>{data['hitCount']}</strong></div><div class="stat"><span>命中页面</span><strong>{data['pageCount']}</strong></div><div class="stat"><span>已确认</span><strong>{data['reviewCounts']['confirmed']}</strong></div><div class="stat"><span>待复核</span><strong>{data['reviewCounts']['needs_review']}</strong></div><div class="stat"><span>已拒绝</span><strong>{data['reviewCounts']['rejected']}</strong></div><div class="stat"><span>未校对</span><strong>{data['reviewCounts']['unreviewed']}</strong></div></div>
<div id="results-start" class="toolbar"><div class="control"><label for="file-filter">文件筛选</label><select id="file-filter"><option value="">全部文件</option></select></div><div class="control"><label for="status-filter">校对状态</label><select id="status-filter"><option value="">全部状态</option><option value="unreviewed">未校对</option><option value="needs_review">待复核</option><option value="rejected">已拒绝</option><option value="confirmed">已确认</option></select></div><div class="control search"><label for="report-search">关键词搜索</label><input id="report-search" type="search" placeholder="搜索文件、路径、命中、上下文或备注"></div><div class="control"><label for="sort-order">结果排序</label><select id="sort-order"><option value="sequence" selected>序号升序</option><option value="source">文件顺序 + 页码升序</option><option value="fileAsc">文件名升序</option><option value="fileDesc">文件名降序</option><option value="pageAsc">页码升序</option><option value="pageDesc">页码降序</option><option value="confidence">置信度升序</option><option value="status">校对状态优先</option></select></div><div class="control"><label for="page-size">每页命中记录</label><select id="page-size"><option value="10">10</option><option value="20" selected>20</option><option value="50">50</option><option value="100">100</option></select></div><button id="reset-filters" class="secondary-button" type="button">重置</button></div>
<p id="result-summary" class="result-summary" aria-live="polite"></p><div id="review-layout" class="review-layout"><aside id="record-nav" class="record-nav"><div class="record-nav-head"><h2 class="record-nav-title">命中导航</h2><button id="record-nav-toggle" class="secondary-button record-nav-toggle" type="button" aria-expanded="true" aria-controls="record-nav-list" aria-label="收起命中导航">收起</button></div><nav id="record-nav-list" class="record-nav-list" aria-label="全部筛选结果导航"></nav></aside><div class="result-pane"><div id="result-list" class="result-list"></div><nav id="pager" class="pager" aria-label="报告分页"><button id="first-page" class="page-button" type="button">首页</button><button id="prev-page" class="page-button" type="button">上一页</button><span id="page-indicator" class="page-indicator"></span><button id="next-page" class="page-button" type="button">下一页</button><button id="last-page" class="page-button" type="button">末页</button></nav></div></div></section></main>
<button id="back-top" class="back-top" type="button" hidden>返回顶部</button><section id="image-modal" class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" hidden><header class="modal-head"><strong id="modal-title"></strong><button id="modal-close" class="modal-button modal-close" type="button" aria-label="关闭大图">关闭</button></header><div id="modal-image" class="modal-stage"></div><footer class="modal-actions"><button id="modal-prev" class="modal-button" type="button">上一条</button><button id="modal-next" class="modal-button" type="button">下一条</button></footer></section><script>"""
    return prefix, "</script></body></html>"


def write_offline_review_report(
    *,
    output_path: Path,
    task: dict[str, Any],
    items: Iterable[dict[str, Any]],
    integrity: dict[str, Any],
    workspace_dir: Path | None,
    exported_at: str,
    expected_page_count: int | None = None,
    progress: Callable[[str, int, int], None] | None = None,
    page_image_resolver: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
) -> dict[str, int]:
    """分批读取记录、逐页嵌入原图并原子写入单文件离线报告。"""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".archivelens-export-", dir=output_path.parent) as temporary:
        temporary_dir = Path(temporary)
        pages_path = temporary_dir / "pages.json"
        script_path = temporary_dir / "report.js"
        partial_path = temporary_dir / "report.partial.html"
        files, page_count, hit_count = _stream_page_data(
            items=items,
            pages_path=pages_path,
            workspace_dir=workspace_dir,
            expected_page_count=expected_page_count,
            progress=progress,
            page_image_resolver=page_image_resolver,
        )
        data = _report_metadata(
            task=task,
            integrity=integrity,
            exported_at=exported_at,
            files=files,
            page_count=page_count,
            hit_count=hit_count,
        )
        _write_script(script_path, pages_path, data)
        if progress is not None:
            progress("building", page_count, page_count)
        script_hash = _csp_hash_file(script_path)
        empty_size_field = " " * REPORT_SIZE_FIELD_WIDTH
        prefix, suffix = _document_parts(data, script_hash=script_hash, report_size_label=empty_size_field)
        report_size = len(prefix.encode("utf-8")) + script_path.stat().st_size + len(suffix.encode("utf-8"))
        size_label = _format_file_size(report_size)
        if len(size_label) > REPORT_SIZE_FIELD_WIDTH:
            raise ValueError("report size label exceeds reserved field")
        prefix, suffix = _document_parts(
            data,
            script_hash=script_hash,
            report_size_label=size_label.ljust(REPORT_SIZE_FIELD_WIDTH),
        )
        if progress is not None:
            progress("writing", hit_count, hit_count)
        with partial_path.open("wb") as output:
            output.write(prefix.encode("utf-8"))
            with script_path.open("rb") as script:
                shutil.copyfileobj(script, output, length=1024 * 1024)
            output.write(suffix.encode("utf-8"))
        actual_size = partial_path.stat().st_size
        if actual_size != report_size:
            raise RuntimeError(f"report size calculation mismatch: expected {report_size}, got {actual_size}")
        os.replace(partial_path, output_path)
    return {"file_size_bytes": report_size, "page_count": page_count, "hit_count": hit_count}


def build_offline_review_report(
    *,
    task: dict[str, Any],
    items: Iterable[dict[str, Any]],
    integrity: dict[str, Any],
    workspace_dir: Path | None,
    exported_at: str,
    progress: Callable[[str, int, int], None] | None = None,
) -> str:
    """兼容测试和调用方的字符串返回入口；正式导出使用流式文件 API。"""
    with tempfile.TemporaryDirectory(prefix="archivelens-report-build-") as temporary:
        output_path = Path(temporary) / "report.html"
        write_offline_review_report(
            output_path=output_path,
            task=task,
            items=items,
            integrity=integrity,
            workspace_dir=workspace_dir,
            exported_at=exported_at,
            progress=progress,
        )
        return output_path.read_text(encoding="utf-8")


__all__ = ["build_offline_review_report", "write_offline_review_report"]
