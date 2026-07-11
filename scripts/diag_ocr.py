"""诊断 RapidOCR 对 fixture PDF 渲染图的识别（区分识别 vs 管线逻辑）。"""
from pathlib import Path

import pypdfium2 as pdfium
from rapidocr_onnxruntime import RapidOCR

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "ocr" / "simplified-horizontal.pdf"
OUT = ROOT / "tests" / "fixtures" / "ocr" / "_diag.png"

pdf = pdfium.PdfDocument(str(FIXTURE))
pil = pdf[0].render(scale=2.0).to_pil()
pil.save(OUT)
pdf.close()
print("rendered", pil.size, "->", OUT)

r = RapidOCR()
res = r(str(OUT))
print("raw type:", type(res))
texts = []
if res and res[0]:
    for item in res[0]:
        # RapidOCR item: [box, text, score]
        texts.append(item[1])
print("texts:", texts)
print("has 约:", any("约" in t for t in texts))
