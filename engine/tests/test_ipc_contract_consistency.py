"""P1-8 Commit 4 — Python 正式 IPC 契约一致性测试。

读取 contracts/engine-methods.json 与 contracts/electron-channels.json，
导入 Python ENGINE_HANDLERS，断言：

1. 契约方法集合 == ENGINE_HANDLERS.keys()（42）；
2. 每个契约 python_handler 与 ENGINE_HANDLERS[method].__name__ 精确一致；
3. 协议版本 == PROTOCOL_VERSION == 4；
4. 分类数量 38/3/1，且 internal/test 精确方法集合；
5. 模块级 ENGINE_HANDLERS 无重复键、_register_defaults 调用 update(ENGINE_HANDLERS)。

本测试不修改 Python 生产代码，不修改正式契约。与 TS 端 ipcContractConsistency.spec.ts
互为校验源。
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
ENGINE_CONTRACT_PATH = REPO_ROOT / "contracts" / "engine-methods.json"
SERVER_PATH = REPO_ROOT / "engine" / "src" / "archivelens_engine" / "server.py"


def load_contract() -> dict:
    return json.loads(ENGINE_CONTRACT_PATH.read_text(encoding="utf-8"))


def extract_engine_handlers_keys_from_source() -> tuple[list[str], list[str]]:
    """AST 解析模块级 ENGINE_HANDLERS 字典字面量的字符串键，返回 (keys, duplicates)。"""
    source = SERVER_PATH.read_text(encoding="utf-8")
    tree = ast.parse(source)
    for node in tree.body:
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
    source = SERVER_PATH.read_text(encoding="utf-8")
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == "_register_defaults":
            for sub in ast.walk(node):
                if (
                    isinstance(sub, ast.Call)
                    and isinstance(sub.func, ast.Attribute)
                    and sub.func.attr == "update"
                    and sub.args
                    and isinstance(sub.args[0], ast.Name)
                    and sub.args[0].id == "ENGINE_HANDLERS"
                ):
                    return
            raise AssertionError("_register_defaults 未调用 self.handlers.update(ENGINE_HANDLERS)")
    raise AssertionError("未找到 _register_defaults 方法")


class IpcContractConsistencyTests(unittest.TestCase):
    """正式契约与 Python ENGINE_HANDLERS 的一致性门禁。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.contract = load_contract()
        cls._tmpdir = tempfile.TemporaryDirectory()
        with patch.dict(os.environ, {"AL_SLOWFAKE_PAGES": "1"}, clear=False):
            from archivelens_engine.server import ENGINE_HANDLERS, Server
            from archivelens_engine import PROTOCOL_VERSION

            cls.engine_handlers = ENGINE_HANDLERS
            cls.protocol_version = PROTOCOL_VERSION
            cls.server = Server(workspace_root=cls._tmpdir.name)
            cls.runtime_handlers = set(cls.server.handlers.keys())
        cls.source_keys, cls.source_dupes = extract_engine_handlers_keys_from_source()

    @classmethod
    def tearDownClass(cls) -> None:
        try:
            cls.server.store.close()
        finally:
            cls._tmpdir.cleanup()

    # ---- 1. 方法集合一致 ----
    def test_contract_methods_equal_handlers(self) -> None:
        contract_methods = {m["method"] for m in self.contract["engine_methods"]}
        handler_keys = set(self.engine_handlers.keys())
        self.assertEqual(len(contract_methods), 42)
        self.assertEqual(len(handler_keys), 42)
        missing = sorted(contract_methods - handler_keys)
        extra = sorted(handler_keys - contract_methods)
        self.assertEqual(
            (missing, extra),
            ([], []),
            "契约 method 与 ENGINE_HANDLERS 不一致\n"
            f"  Missing in handlers: {missing}\n"
            f"  Unexpected handlers: {extra}",
        )

    # ---- 2. handler 函数名精确映射 ----
    def test_python_handler_name_exact_match(self) -> None:
        for entry in self.contract["engine_methods"]:
            method = entry["method"]
            declared = entry["python_handler"]
            actual = self.engine_handlers[method]
            self.assertEqual(
                actual.__name__,
                declared,
                f"{method}: 契约 python_handler={declared!r} 与实际 {actual.__name__!r} 不一致",
            )

    # ---- 3. 协议版本 ----
    def test_protocol_version_matches(self) -> None:
        self.assertEqual(self.contract["protocol_version"], 4)
        self.assertEqual(self.protocol_version, 4)

    # ---- 4. 分类数量与精确集合 ----
    def test_visibility_counts(self) -> None:
        methods = self.contract["engine_methods"]
        public = [m["method"] for m in methods if m["visibility"] == "engine_public"]
        internal = [m["method"] for m in methods if m["visibility"] == "engine_internal"]
        test = [m["method"] for m in methods if m["visibility"] == "engine_test"]
        self.assertEqual(len(public), 38)
        self.assertEqual(len(internal), 3)
        self.assertEqual(len(test), 1)

    def test_internal_methods_exact(self) -> None:
        methods = self.contract["engine_methods"]
        internal = {m["method"] for m in methods if m["visibility"] == "engine_internal"}
        self.assertEqual(internal, {"app.info", "app.shutdown", "diagnostics.run"})

    def test_test_methods_exact(self) -> None:
        methods = self.contract["engine_methods"]
        test = {m["method"] for m in methods if m["visibility"] == "engine_test"}
        self.assertEqual(test, {"tasks.inspectState"})

    # ---- 5. ENGINE_HANDLERS 源码与运行时一致 ----
    def test_source_keys_count_42_no_duplicates(self) -> None:
        unique = set(self.source_keys)
        self.assertEqual(len(unique), 42)
        self.assertEqual(self.source_dupes, [], f"源码重复键: {self.source_dupes}")

    def test_source_equals_runtime_equals_contract(self) -> None:
        source_set = set(self.source_keys)
        contract_methods = {m["method"] for m in self.contract["engine_methods"]}
        self.assertEqual(source_set, self.runtime_handlers)
        self.assertEqual(source_set, contract_methods)

    def test_register_defaults_uses_engine_handlers(self) -> None:
        assert_register_defaults_uses_engine_handlers()


if __name__ == "__main__":
    unittest.main()
