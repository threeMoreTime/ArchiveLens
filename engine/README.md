# ArchiveLens Engine

本地 OCR 引擎：在 PDF、DJVU/DJV、TIFF、JPEG、PNG 档案中检索用户指定的文字或词语，产出可校对的离线报告。

该包同时提供两种入口：

| 入口 | 用途 | 面向 |
| --- | --- | --- |
| `archivelens-engine serve` | JSONL stdin/stdout Sidecar | Electron Main 进程驱动 |
| `archivelens-engine --root-dir ...` | 传统 CLI | 批处理 / CI / 高级用户 |

## 目录结构

```
engine/
├─ pyproject.toml
├─ requirements-lock.txt
├─ src/archivelens_engine/
│  ├─ __init__.py          # 版本号 + PROTOCOL_VERSION
│  ├─ __main__.py          # 模式分流入口
│  ├─ config.py            # EngineConfig：原生工具路径单一真相源
│  ├─ protocol.py          # JSONL 协议 + 错误码
│  ├─ server.py            # Sidecar server
│  ├─ diagnostics.py       # 环境自检
│  ├─ ocr_core.py          # 纯函数 OCR 算法（bbox/去重/分类）
│  ├─ report_pipeline.py   # 主管线（扫描/SQLite/报告/合并）
│  └─ progress_dashboard.py
└─ tests/                  # unittest，`python -m unittest discover`
```

## 开发

```bash
# 运行测试（无需安装，使用 PYTHONPATH）
PYTHONPATH="engine/src;engine" python -m unittest discover -s engine/tests -t engine
```

## 原生依赖

* Tesseract OCR 5.5.0（可选的二次识别；单字符与词语均可用）
* DjVuLibre 3.5.29 的 `ddjvu` / `djvused`（DJVU/DJV 解析）
* `chi_sim`、`chi_tra`、`chi_sim_vert`、`chi_tra_vert` 中文模型

路径均通过 `EngineConfig` 解析，可被 `AL_TESSERACT_CMD` / `AL_DJVU_BIN_DIR` / `AL_TESSDATA_DIR` 环境变量覆盖。完整 Setup 与 Portable 均内置这些组件，生产模式由 Electron Main 强制注入包内路径；开发模式仍允许显式覆盖。
