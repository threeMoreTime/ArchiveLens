# 原生依赖

ArchiveLens 的 PDF 主链路随包包含 pypdfium2/PDFium、RapidOCR 与 ONNX Runtime。可选二次复核和 DJVU 支持仍依赖宿主原生组件（见 [../THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)）。

TIFF、JPEG、PNG 由随 Engine 安装的 Pillow 解码，不要求用户另外安装图片查看器或系统编解码包。环境诊断会检查 JPEG、PNG 与 libtiff 能力；任一能力缺失时对应图片格式不可用。

## 当前状态

packaged Engine 对以下可选能力依赖宿主已安装的原生工具：

- Tesseract（`C:\Program Files\Tesseract-OCR`）
- DjVuLibre（`C:\Program Files (x86)\DjVuLibre`，提供 `ddjvu` / `djvused`）
- tessdata 语言包（`chi_sim` / `chi_tra` 等）

`diagnostics.run` 在缺组件时返回 `FAIL` / `WARN` 并给出影响与处理建议；PDF 扫描不依赖 DjVuLibre，DJVU 扫描依赖之。

## 许可证边界

| 依赖 | 许可证 | 问题 |
| --- | --- | --- |
| DjVuLibre | GPL-2.0 | 传染性；需评估随包影响或动态链接 / 应用内安装 |
| RapidOCR 模型 / tessdata | 需核实 | 逐文件确认来源与许可证 |

Tesseract、tessdata 与 DjVuLibre 当前不随包分发。生产包不包含 PyMuPDF/fitz。

## 合法分发方案（下一迭代）

1. DjVuLibre：评估 GPL 影响，或维持宿主安装；
2. 语言包核实后再决定是否随 `resources/tessdata/` 分发；
3. 如实现应用内组件安装器，必须使用 HTTPS、SHA-256 校验、用户显式确认和原子安装，不得静默下载。

Engine 配置解析优先级：打包资源目录 → 用户配置 → 环境变量 → PATH → 常见安装目录。生产不优先使用开发机全局安装。
