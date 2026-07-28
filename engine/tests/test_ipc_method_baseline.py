"""P1-8 IPC 契约统一 — Commit 1 Python 基线测试。

与 apps/desktop/tests/ipcMethodBaseline.spec.ts 配对，确保 Python 端真实
handler 集合与 contracts/ipc-method-audit.baseline.json 锁定一致。

本测试同时：
1. 动态实例化 Server（AL_SLOWFAKE_PAGES=1 + TemporaryDirectory），读取
   set(server.handlers.keys())；
2. 用 ast 解析 server.py 的 `_register_defaults` 字典字面量，提取源码声明的
   handler 键，检测源码级重复声明（动态 dict 会覆盖重复键，无法单独发现）；
3. 三方（源码 AST / 运行时 dict / baseline）一致性比对。

本测试不修改生产 IPC 行为。
"""

from __future__ import annotations

import ast
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[2]
BASELINE_PATH = REPO_ROOT / "contracts" / "ipc-method-audit.baseline.json"
SERVER_PATH = REPO_ROOT / "engine" / "src" / "archivelens_engine" / "server.py"


def load_baseline() -> dict:
    return json.loads(BASELINE_PATH.read_text(encoding="utf-8"))


def extract_handler_keys_from_source() -> tuple[list[str], list[str]]:
    """用 AST 解析 _register_defaults 内部 dict 字面量的字符串键。

    返回 (keys_in_order, duplicate_keys)：
      - keys_in_order：源码声明顺序的全部键（含重复）；
      - duplicate_keys：在源码中重复声明的键。
    """
    source = SERVER_PATH.read_text(encoding="utf-8")
    tree = ast.parse(source)
    register_node: ast.FunctionDef | None = None
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.FunctionDef)
            and node.name == "_register_defaults"
        ):
            register_node = node
            break
    assert register_node is not None, "未找到 Server._register_defaults"

    # 在函数体内查找 self.handlers.update({...}) 的 dict 字面量
    keys: list[str] = []
    for node in ast.walk(register_node):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "update"
        ):
            for arg in node.args:
                if isinstance(arg, ast.Dict):
                    for k in arg.keys:
                        if isinstance(k, ast.Constant) and isinstance(k.value, str):
                            keys.append(k.value)

    seen: set[str] = set()
    dupes: list[str] = []
    for k in keys:
        if k in seen:
            dupes.append(k)
        seen.add(k)
    return keys, dupes


class IpcMethodBaselinePythonTests(unittest.TestCase):
    """核验 Python handler 集合与 baseline 一致，并校验已知差异真实性。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.baseline = load_baseline()
        cls.expected_handlers = set(cls.baseline["python_handlers"])
        cls.schema_methods = set(cls.baseline["method_name_schema"])
        cls.source_keys, cls.source_dupes = extract_handler_keys_from_source()
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

    def test_source_handler_keys_count_is_42(self) -> None:
        # 源码 AST 提取的去重键数量应为 42（与运行时一致）
        unique_source_keys = set(self.source_keys)
        self.assertEqual(
            len(unique_source_keys),
            42,
            f"源码 _register_defaults 声明的 handler 数量应为 42，"
            f"实际 {len(unique_source_keys)}: {sorted(unique_source_keys)}",
        )

    def test_source_has_no_duplicate_handler_keys(self) -> None:
        # 动态 dict 会覆盖重复键，运行时无法单独发现源码级重复；
        # 通过 AST 在源码层检测重复声明。
        self.assertEqual(
            self.source_dupes,
            [],
            f"源码 _register_defaults 中存在重复声明的 handler 键: {self.source_dupes}",
        )

    def test_handlers_match_baseline_exactly(self) -> None:
        missing = sorted(self.expected_handlers - self.actual_handlers)
        extra = sorted(self.actual_handlers - self.expected_handlers)
        self.assertEqual(
            (missing, extra),
            ([], []),
            "Python handler 运行时集合与 baseline 不一致\n"
            f"  Missing in handlers: {missing or '(无)'}\n"
            f"  Unexpected handlers: {extra or '(无)'}",
        )

    def test_source_keys_match_runtime_and_baseline(self) -> None:
        """三方一致性：源码 AST / 运行时 dict / baseline 三者 handler 集合完全一致。"""
        source_set = set(self.source_keys)
        runtime_set = self.actual_handlers
        baseline_set = self.expected_handlers

        self.assertEqual(
            source_set,
            runtime_set,
            "源码 AST 与运行时 handler 集合不一致\n"
            f"  In source only: {sorted(source_set - runtime_set) or '(无)'}\n"
            f"  In runtime only: {sorted(runtime_set - source_set) or '(无)'}",
        )
        self.assertEqual(
            source_set,
            baseline_set,
            "源码 AST 与 baseline handler 集合不一致\n"
            f"  In source only: {sorted(source_set - baseline_set) or '(无)'}\n"
            f"  In baseline only: {sorted(baseline_set - source_set) or '(无)'}",
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

    def test_baseline_arrays_have_no_duplicates(self) -> None:
        """对 baseline 的所有数组字段断言无重复项。"""
        array_keys = [
            "method_name_schema",
            "typescript_engine_calls",
            "parse_method_result_covered",
            "python_handlers",
            "electron_local_channels",
            "electron_forwarded_channels",
            "electron_test_local_channels",
            "electron_test_forwarded_channels",
        ]
        for key in array_keys:
            values = self.baseline[key]
            unique = len(set(values))
            self.assertEqual(
                unique,
                len(values),
                f"baseline.{key} 不应有重复项（{len(values) - unique} 个重复）",
            )


if __name__ == "__main__":
    unittest.main()
