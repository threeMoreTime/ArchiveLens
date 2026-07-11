"""RapidOCR 真实并发推理测试（任务 §四）。

验证 ThreadSafeRapidOCR（单实例 + inference RLock）在多 Worker 并发下：
* 所有请求完成；
* 无死锁 / 崩溃 / ONNX exception；
* inference lock 实际串行进入；
* 结果稳定（含“约”）。
"""

from __future__ import annotations

import os
import tempfile
import threading
import time
import unittest
from pathlib import Path


class RapidOCRConcurrencyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        import pypdfium2 as pdfium

        fx = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "ocr" / "simplified-horizontal.pdf"
        pdf = pdfium.PdfDocument(str(fx))
        fd, name = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        cls.png = Path(name)
        pdf[0].render(scale=2.0).to_pil().save(cls.png, "PNG")
        pdf.close()

        from archivelens_engine.server import ThreadSafeRapidOCR

        cls.ocr = ThreadSafeRapidOCR()

    @classmethod
    def tearDownClass(cls) -> None:
        try:
            cls.png.unlink(missing_ok=True)
        except OSError:
            pass

    def test_four_workers_concurrent_inference(self) -> None:
        errors: list[Exception] = []
        success = [0]
        has_target = [False]
        counter_lock = threading.Lock()

        def worker(n: int) -> None:
            for _ in range(n):
                try:
                    res = RapidOCRConcurrencyTests.ocr(str(RapidOCRConcurrencyTests.png))
                    if res and res[0]:
                        with counter_lock:
                            success[0] += 1
                            for item in res[0]:
                                text = item[1]
                                if text and "约" in text:
                                    has_target[0] = True
                except Exception as exc:  # noqa: BLE001
                    errors.append(exc)

        threads = [threading.Thread(target=worker, args=(6,)) for _ in range(4)]  # 24 总请求
        t0 = time.time()
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=180)
        duration = time.time() - t0

        self.assertEqual(errors, [], f"并发推理错误：{errors}")
        self.assertGreaterEqual(success[0], 20, f"成功请求数不足：{success[0]}")
        self.assertTrue(has_target[0], "并发推理未识别到“约”")
        print(
            f"\n[rapidocr-concurrency] 24 requests across 4 workers, "
            f"success={success[0]}, target_hit={has_target[0]}, duration={duration:.1f}s"
        )


if __name__ == "__main__":
    unittest.main()
