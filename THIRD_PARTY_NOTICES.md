# Third-Party Notices

ArchiveLens 包含或依赖以下第三方组件。本清单基于各项目公开的许可证信息整理；
**正式发布前必须逐项到官方来源最终核实版本与许可证文本**（任务 §十.1：不得虚构）。

## Python Engine 运行时依赖

| 组件 | 许可证 | 说明 |
| --- | --- | --- |
| [pypdfium2 / PDFium](https://pypdfium2.readthedocs.io/) | BSD-3-Clause / BSD-style | PDF 图片渲染主链路；包内保留对应许可证文本。 |
| [Pillow](https://python-pillow.org/) | HPND-like（CMU License） | 允许再分发，需保留版权声明。 |
| [RapidOCR (rapidocr-onnxruntime)](https://github.com/RapidAI/RapidOCR) | Apache-2.0 | 含模型文件，需确认模型单独许可证（见下）。 |
| [ONNX Runtime](https://onnxruntime.ai/) | MIT | 含原生 DLL，允许再分发。 |
| [pytesseract](https://github.com/madmaze/pytesseract) | Apache-2.0 | Python 封装层。 |
| [Tesseract OCR](https://github.com/tesseract-ocr/tesseract) | Apache-2.0 | 原生可执行；语言包见下。 |
| [DjVuLibre](https://djvu.sourceforge.net/) | **GPL-2.0** | ⚠️ GPL-2.0 具传染性；若直接随包分发，需评估对整体许可证的影响。当前默认不随包分发二进制，由用户已安装或后续应用内安装。 |

### OCR 模型与语言包（独立许可证，需单独核实）

| 资源 | 来源 | 许可证 |
| --- | --- | --- |
| RapidOCR ONNX 模型 | RapidAI 发布 | 需核实模型本身的许可证（通常 Apache-2.0，但发布前确认）。 |
| `chi_sim` / `chi_sim_vert` 简体中文 traineddata | tesseract-ocr/tessdata | Apache-2.0（`tessdata` 仓库）；`tessdata_best` 同。**`tessdata_fast`/`tessdata_best` 来自 `tessdata_fast` 等仓库，需核实。** |
| `chi_tra` / `chi_tra_vert` 繁体中文 traineddata | 同上 | 同上。 |

> Tesseract、tessdata 与 DjVuLibre 当前不随安装包分发。
> 当前的 packaged Engine 在 `diagnostics.run` 中对语言包检测为 FAIL/WARN（依赖宿主已安装）。
> 生产包不包含 PyMuPDF/fitz；未来若改变宿主依赖策略，必须重新完成许可证审查。

## 桌面端依赖

| 组件 | 许可证 |
| --- | --- |
| [Electron](https://www.electronjs.org/) | MIT（含 Chromium / Node.js，各自 BSD/MIT/等） |
| [electron-builder](https://www.electron.build/) | MIT |
| [electron-vite](https://electron-vite.org/) | MIT |
| [React](https://react.dev/) | MIT |
| [Fluent UI React v9](https://react.fluentui.dev/) | MIT |
| [React Router](https://reactrouter.com/) | MIT |
| [Zustand](https://github.com/pmndrs/zustand) | MIT |
| [TanStack Query / Virtual](https://tanstack.com/) | MIT |
| [Zod](https://zod.dev/) | MIT |
| [Vitest](https://vitest.dev/) | MIT |
| [Playwright](https://playwright.dev/) | Apache-2.0 |

## 字体

应用界面使用 Windows 系统字体（Microsoft YaHei 等），未随包分发字体文件。

---

## 发布前阻塞（不得绕过）

1. **DjVuLibre GPL-2.0**：维持宿主安装；若未来改为随包分发，必须重新完成许可证审查。
2. **语言包**：逐文件核实来源与许可证后再决定是否分发。
3. **RapidOCR 模型**：发布证据链记录实际随包模型和第三方许可文件。

> 本清单为占位与风险提示，**不构成法律意见**。发布前请由有资质的人员完成最终许可证审查。
