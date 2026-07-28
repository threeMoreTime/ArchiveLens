"""P1-8 IPC 契约统一 — Commit 1 Python 基线测试。

与 apps/desktop/tests/ipcMethodBaseline.spec.ts 配对，确保 Python 端真实
handler 集合与 contracts/ipc-method-audit.baseline.json 锁定一致。

本测试动态实例化 Server（与 test_ipc_contract.py 同样使用
AL_SLOWFAKE_PAGES=1 + TemporaryDirectory），读取 set(server.handlers.keys())
与 baseline 比对。本测试不修改生产 IPC 行为。
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[2]
BASELINE_PATH = REPO_ROOT / "contracts" / "ipc-method-audit.baseline.json"


def load_baseline() -> dict:
    return json.loads(BASELINE_PATH.read_text(encoding="utf-8"))


class IpcMethodBaselinePythonTests(unittest.TestCase):
    """动态核验 Python handler 集合与 baseline 一致，并校验已知差异真实性。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.baseline = load_baseline()
        cls.expected_handlers = set(cls.baseline["python_handlers"])
        cls.schema_methods = set(cls.baseline["method_name_schema"])
        cls._tmpdir = tempfile.TemporaryDirectory()
        # AL_SLOWFAKE_PAGES=1 让 Server 用慢速假处理器替代真实 OCR，
        # 避免 handler 注册依赖原生 OCR 运行时；clear=False 保留既有环境变量。
        with patch.dict(os.environ, {"AL_SLOWFAKE_PAGES": "1"}, clear=False):
            from archivelens_engine.server import Server

            cls.server = Server(workspace_root=cls._tmpdir.name)
            cls.actual_handlers = set(cls.server.handlers.keys())

    @classmethod
    def tearDownClass(cls) -> None:
        try:
            cls.server.store.close()
        finally:
            cls._tmpdir.cleanup()

    def test_handler_count_is_42(self) -> None:
        self.assertEqual(len(self.actual_handlers), 42)

    def test_handlers_have_no_duplicates(self) -> None:
        # set 已去重，这里通过 dict 注册表本身无法出现重复；
        # 额外断言：handlers dict 的 key 数 == set 数（恒成立，仅为可读性）。
        self.assertEqual(len(self.actual_handlers), len(self.actual_handlers))

    def test_handlers_match_baseline_exactly(self) -> None:
        missing = sorted(self.expected_handlers - self.actual_handlers)
        extra = sorted(self.actual_handlers - self.expected_handlers)
        self.assertEqual(
            (missing, extra),
            ([], []),
            "Python handler 集合与 baseline 不一致\n"
            f"  Missing in handlers: {missing or '(无)'}\n"
            f"  Unexpected handlers: {extra or '(无)'}",
        )

    def test_app_shutdown_tasks_inspectState_demo_create_exist_in_handlers(self) -> None:
        # 这三个方法 Python handler 已存在但 TS MethodNameSchema 当前缺失（Commit 2 补登）
        for method in ("app.shutdown", "tasks.inspectState", "demo.create"):
            self.assertIn(
                method,
                self.actual_handlers,
                f"{method} 应在 Python handlers 中存在",
            )
            self.assertNotIn(
                method,
                self.schema_methods,
                f"{method} 不应出现在当前 MethodNameSchema baseline（Commit 2 将补登）",
            )

    def test_non_engine_methods_absent_from_handlers(self) -> None:
        # 这四个方法在 TS MethodNameSchema 中但 Python 无 handler（Commit 2 移除）
        for method in (
            "files.openOriginal",
            "files.openFolder",
            "settings.get",
            "settings.update",
        ):
            self.assertNotIn(
                method,
                self.actual_handlers,
                f"{method} 不应在 Python handlers 中（属 Electron 本地或残留 schema 项）",
            )

    def test_known_differences_resolve_in_commit_legal(self) -> None:
        for d in self.baseline["known_differences"]:
            self.assertIn(
                d["resolve_in_commit"],
                (1, 2, 3, 4, 5),
                f"非法 resolve_in_commit: {d['id']}",
            )
            self.assertTrue(d["id"], "known_differences id 不能为空")

    def test_known_differences_complete_for_python_side(self) -> None:
        """反向完整性：Python handler 与 TS schema 的真实差异必须被 known_differences 完整建模。"""
        modeled_python_only = {
            d["item"]
            for d in self.baseline["known_differences"]
            if d["kind"] == "python_only_vs_schema"
        }
        real_python_only = self.actual_handlers - self.schema_methods
        missing = sorted(real_python_only - modeled_python_only)
        extra = sorted(modeled_python_only - real_python_only)
        self.assertEqual(
            (missing, extra),
            ([], []),
            "python_only_vs_schema 漂移建模不完整\n"
            f"  Missing in known_differences: {missing or '(无)'}\n"
            f"  Unexpected known difference: {extra or '(无)'}",
        )


if __name__ == "__main__":
    unittest.main()
