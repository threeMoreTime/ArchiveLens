# Third-Party Notices

ArchiveLens 是本地优先的 Windows 桌面应用，发行包包含下列第三方代码、模型和
原生二进制。精确版本、来源与 SHA-256 以 `engine/requirements-lock.txt`、
`scripts/native-dependencies.lock.json` 和冻结候选的 release manifest 为准。

完整安装包内的许可证和源码证据位于 `resources/licenses/` 与
`resources/sources/`。同一份 Apache License 2.0 全文位于
`resources/licenses/Tesseract/LICENSE.txt`，适用于下表中标记为 Apache-2.0
且没有独立附加条款的组件；组件归属仍以本声明分别列明。

## ArchiveLens

ArchiveLens 自有代码采用 MIT License，全文位于
`resources/licenses/ArchiveLens/LICENSE.txt`。

## Python Engine 与模型

| 组件 | 锁定版本 | 许可证或权利信息 | 分发说明 |
| --- | --- | --- | --- |
| pypdfium2 / PDFium | 5.11.0 / 随 wheel | BSD-3-Clause / BSD-style | PDF 渲染；PyInstaller 包内保留随 wheel 提供的许可材料。 |
| Pillow | 12.1.1 | HPND-like（CMU License） | 图像解码与处理。 |
| RapidOCR (`rapidocr-onnxruntime`) | 1.4.4 运行库；RapidOCR 3.9.1 转换模型 | 工程代码元数据为 Apache-2.0；上游声明 OCR 模型版权归百度 | 检测和方向模型保留 PP-OCRv4；唯一文字识别模型锁定为 PP-OCRv6 small（18,680 字表），用于直接保留简繁字形并输出 CTC 候选。技术门禁记录实际文件名、大小和 SHA-256；模型公开再分发必须单独人工审核。 |
| ONNX Runtime | 1.24.4 | MIT | 包内保留 `onnxruntime/LICENSE` 与 `ThirdPartyNotices.txt`。 |
| OpenCC | 1.2.0 | Apache-2.0 | 仅在本机生成简体、标准繁体、台湾和香港字形关系，并约束同一 OCR 模型内的简繁字形复核；OCR 上下文原文始终单独保留。 |
| pytesseract | 0.3.13 | Apache-2.0 | Tesseract Python 封装。 |
| Tesseract OCR | 5.5.0.20241111 | Apache-2.0 | 原生可执行与 Windows 构建信息随包。 |
| tessdata_fast | 固定提交 `87416418657359cb625c412a48b6e1d6d41c29bd` | Apache-2.0 | `chi_sim`、`chi_tra`、`chi_sim_vert`、`chi_tra_vert` 均逐文件锁定 SHA-256。 |

RapidOCR 上游许可证文件：
`https://github.com/RapidAI/RapidOCR/blob/v1.4.4/LICENSE`。上游同版本 README
明确区分工程代码版权与模型版权，因此 Apache-2.0 项目标识不能被自动解释为
已经完成模型公开再分发审核。

## DjVuLibre

ArchiveLens 内置 SourceForge 发布的
`DjVuLibre-3.5.29_DjView-4.12_Setup.exe` 中以下运行时文件：

- `ddjvu.exe`
- `djvused.exe`
- `libdjvulibre.dll`
- `libjpeg.dll`
- `libtiff.dll`
- `libz.dll`
- `COPYING.txt`

依赖锁将该组件标记为 GPL-2.0-only。发行包同时提供：

- GPL-2.0 全文：`resources/licenses/DjVuLibre/COPYING.txt`
- 对应上游源码：`resources/sources/djvulibre/djvulibre-3.5.29.tar.gz`
- Windows 二进制、源码归档和运行树的 SHA-256：
  `resources/native-dependencies.lock.json`

ArchiveLens 通过参数数组和 `shell: false` 启动 `ddjvu.exe` / `djvused.exe`，
不把 DjVuLibre 链接进 Electron 或 Python 进程。该工程边界、许可证文本和源码
归档是技术事实，不替代对具体发行方式下 GPL 义务的人工判断。

Windows 包中的 `libjpeg.dll`、`libtiff.dll` 与 `libz.dll` 来自同一锁定的
DjVuLibre Windows 制品。公开发布前必须人工确认这些二进制与所附源码、声明及
上游构建材料之间的对应关系。

## 桌面端

| 组件 | 许可证 |
| --- | --- |
| Electron（含 Chromium / Node.js 的各自声明） | MIT / BSD / 其他随发行材料提供的许可 |
| electron-builder | MIT |
| electron-vite | MIT |
| React / React DOM | MIT |
| Fluent UI React v9 | MIT |
| React Router | MIT |
| Zustand | MIT |
| TanStack Query / Virtual | MIT |
| Zod | MIT |
| Playwright | Apache-2.0 |

## 字体与用户数据

应用使用 Windows 系统字体，不随包再分发字体文件。测试和发布材料不得包含真实
用户文档、OCR 结果或本地数据库。

## 公开发布阻塞项

以下项目必须在 `docs/compliance/public-release-license-approval.json` 中针对
冻结候选 SHA 完成真实人工审核，默认均为未批准：

1. DjVuLibre Windows 二进制与对应源码关系；
2. 目标发行方式下 DjVuLibre GPL 分发义务；
3. RapidOCR 内置模型的公开再分发权利；
4. 最终安装包和 Portable 中许可证、声明、源码归档及 source offer 的完整性。

技术检查命令见 `docs/compliance/public-release-license-gate.md`。许可证审核通过
也不等于批准正式发布。

本清单是零成本工程证据，不构成法律意见、法律服务或合规保证。
