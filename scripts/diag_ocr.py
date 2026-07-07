"""诊断 RapidOCR 对 fixture PDF 渲染图的识别（区分识别 vs 管线逻辑）。"""
import pypdfium2 as pdfium
from rapidocr_onnxruntime import RapidOCR

fx = "F:/OCR/tests/fixtures/ocr/simplified-horizontal.pdf"
pdf = pdfium.PdfDocument(fx)
pil = pdf[0].render(scale=2.0).to_pil()
out = "F:/OCR/tests/fixtures/ocr/_diag.png"
pil.save(out)
pdf.close()
print("rendered", pil.size, "->", out)

r = RapidOCR()
res = r(out)
print("raw type:", type(res))
texts = []
if res and res[0]:
    for item in res[0]:
        # RapidOCR item: [box, text, score]
        texts.append(item[1])
print("texts:", texts)
print("has 约:", any("约" in t for t in texts))
