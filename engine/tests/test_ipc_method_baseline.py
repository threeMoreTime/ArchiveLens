"""P1-8 IPC 契约统一 — Python 基线测试。

Commit 1：基于 707690c1 建立 contracts/ipc-method-audit.baseline.json 历史审计快照。
Commit 2：引入正式契约 contracts/engine-methods.json 后，本测试同时校验：
  1. 历史审计快照（baseline.json）未被篡改（42 handlers）；
  2. 模块级 ENGINE_HANDLERS 与运行时 server.handlers 一致（42）；
  3. 正式契约 engine-methods.json 的 python_handler 与 ENGINE_HANDLERS 一致；
  4. 历史 known_differences 的真实性仍被保留。

本测试用 ast 解析 server.py 的模块级 ENGINE_HANDLERS 字典字面量，提取源码
声明的 handler 键（检测源码级重复声明，动态 dict 会覆盖重复键无法单独发现），
并与运行时、契约、baseline 三方比对。
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
ENGINE_CONTRACT_PATH = REPO_ROOT / "contracts" / "engine-methods.json"
SERVER_PATH = REPO_ROOT / "engine" / "src" / "archivelens_engine" / "server.py"


def load_json(p: Path) -> dict:
    return json.loads(p.read_text(encoding="utf-8"))


def extract_engine_handlers_keys_from_source() -> tuple[list[str], list[str]]:
    """用 AST 解析模块级 ENGINE_HANDLERS 字典字面量的字符串键。

    返回 (keys_in_order, duplicate_keys)。
    """
    source = SERVER_PATH.read_text(encoding="utf-8")
    tree = ast.parse(source)
    for node in tree.body:
        # AnnAssign: ENGINE_HANDLERS: dict[...] = {...}
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == "ENGINE_HANDLERS":
            if isinstance(node.value, ast.Dict):
                keys: list[str] = []
                for k in node.value.keys:
                    if isinstance(k, ast.Constant) and isinstance(k.value, str):
                        keys.append(k.value)
                seen: set[str] = set()
                dupes: list[str] = []
                for k in keys:
                    if k in seen:
                        dupes.append(k)
                    seen.add(k)
                return keys, dupes
    raise AssertionError("未找到模块级 ENGINE_HANDLERS 字典")


def assert_register_defaults_uses_engine_handlers() -> None:
    """断言 _register_defaults 确实调用 self.handlers.update(ENGINE_HANDLERS)。"""
    source = SERVER_PATH.read_text(encoding="utf-8")
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == "_register_defaults":
            found = False
            for sub in ast.walk(node):
                if (
                    isinstance(sub, ast.Call)
                    and isinstance(sub.func, ast.Attribute)
                    and sub.func.attr == "update"
                    and sub.args
                    and isinstance(sub.args[0], ast.Name)
                    and sub.args[0].id == "ENGINE_HANDLERS"
                ):
                    found = True
                    break
            assert found, "_register_defaults 未调用 self.handlers.update(ENGINE_HANDLERS)"
            return
    raise AssertionError("未找到 _register_defaults 方法")


class IpcMethodBaselinePythonTests(unittest.TestCase):
    """核验 Python handler 集合与历史 baseline、正式契约、运行时一致。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.baseline = load_json(BASELINE_PATH)
        cls.engine_contract = load_json(ENGINE_CONTRACT_PATH)
        cls.expected_handlers = set(cls.baseline["python_handlers"])
        cls.schema_methods = set(cls.baseline["method_name_schema"])
        cls.source_keys, cls.source_dupes = extract_engine_handlers_keys_from_source()
        cls._tmpdir = tempfile.TemporaryDirectory()
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

    # ---- 历史审计快照（不变量）----

    def test_historical_baseline_handler_count(self) -> None:
        self.assertEqual(len(self.expected_handlers), 42)

    def test_historical_baseline_arrays_no_duplicates(self) -> None:
        for key in (
            "method_name_schema",
            "typescript_engine_calls",
            "parse_method_result_covered",
            "python_handlers",
            "electron_local_channels",
            "electron_forwarded_channels",
            "electron_test_local_channels",
            "electron_test_forwarded_channels",
        ):
            values = self.baseline[key]
            self.assertEqual(len(set(values)), len(values), f"baseline.{key} 不应有重复项")

    def test_historical_known_differences_resolve_in_commit_legal(self) -> None:
        for d in self.baseline["known_differences"]:
            self.assertIn(d["resolve_in_commit"], (1, 2, 3, 4, 5), f"非法 resolve_in_commit: {d['id']}")
            self.assertTrue(d["id"], "known_differences id 不能为空")

    # ---- 模块级 ENGINE_HANDLERS ----

    def test_register_defaults_uses_engine_handlers(self) -> None:
        assert_register_defaults_uses_engine_handlers()

    def test_engine_handlers_source_count_is_42(self) -> None:
        unique = set(self.source_keys)
        self.assertEqual(len(unique), 42, f"ENGINE_HANDLERS 应为 42 项，实际 {len(unique)}")

    def test_engine_handlers_source_no_duplicates(self) -> None:
        self.assertEqual(self.source_dupes, [], f"ENGINE_HANDLERS 源码重复键: {self.source_dupes}")

    def test_runtime_handlers_count_is_42(self) -> None:
        self.assertEqual(len(self.actual_handlers), 42)

    def test_four_way_consistency_source_runtime_baseline_contract(self) -> None:
        """四方一致性：源码 AST / 运行时 / 历史 baseline / 正式契约 method 名 完全一致。"""
        source_set = set(self.source_keys)
        runtime_set = self.actual_handlers
        baseline_set = self.expected_handlers
        # 正式契约记录 python_handler（函数名）和 method（方法名）两个字段；
        # 这里比对 method 名（与 handler key 同名空间）。
        contract_methods = {m["method"] for m in self.engine_contract["engine_methods"]}

        self.assertEqual(source_set, runtime_set,
                         "源码与运行时不一致\n"
                         f"  source only: {sorted(source_set - runtime_set)}\n"
                         f"  runtime only: {sorted(runtime_set - source_set)}")
        self.assertEqual(source_set, baseline_set,
                         "源码与 baseline 不一致\n"
                         f"  source only: {sorted(source_set - baseline_set)}\n"
                         f"  baseline only: {sorted(baseline_set - source_set)}")
        self.assertEqual(source_set, contract_methods,
                         "源码与正式契约 engine_methods 不一致\n"
                         f"  source only: {sorted(source_set - contract_methods)}\n"
                         f"  contract only: {sorted(contract_methods - source_set)}")

    # ---- 历史差异真实性（Commit 2 已解决 schema 侧，但 baseline 记录仍为历史）----

    def test_app_shutdown_tasks_inspectState_demo_create_now_in_contract(self) -> None:
        """Commit 2 后这三个方法已在正式契约和 ENGINE_HANDLERS 中。"""
        contract_methods = {m["method"] for m in self.engine_contract["engine_methods"]}
        for method in ("app.shutdown", "tasks.inspectState", "demo.create"):
            self.assertIn(method, self.actual_handlers, f"{method} 应在运行时 handlers 中")
            self.assertIn(method, contract_methods, f"{method} 应在正式契约中")
            # 历史 baseline 记录它们当时缺失，这一历史事实保持不变
            self.assertNotIn(method, self.schema_methods,
                             f"{method} 在历史 baseline schema 中应缺失（历史记录不变）")

    def test_non_engine_methods_absent_from_handlers_and_contract(self) -> None:
        contract_methods = {m["method"] for m in self.engine_contract["engine_methods"]}
        for method in ("files.openOriginal", "files.openFolder", "settings.get", "settings.update"):
            self.assertNotIn(method, self.actual_handlers, f"{method} 不应在 handlers 中")
            self.assertNotIn(method, contract_methods, f"{method} 不应在正式契约中")


if __name__ == "__main__":
    unittest.main()
