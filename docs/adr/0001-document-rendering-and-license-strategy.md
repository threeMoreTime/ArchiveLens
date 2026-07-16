# ADR 0001 — 文档渲染与许可证策略

- 状态：**部分被 ADR 0002 取代**
- 日期：2026-07-07
- 决策者：ArchiveLens 项目

## 背景

ArchiveLens Desktop Alpha 此前使用 **PyMuPDF (fitz)** 渲染 PDF。PyMuPDF 采用
**AGPL-3.0**（或商业授权），其传染性会强制要求分发链路上的「对应源码」披露，
对闭源/未定许可证的桌面发行构成实质义务。

同时 DJVU 渲染依赖 **DjVuLibre**（GPL-2.0），同样具有传染性。

此前 `THIRD_PARTY_NOTICES.md` 把两者简单写成「禁止分发」，这一表述不精确——
许可证允许分发，只是需履行义务。

## 决策（本轮默认架构）

> 2026-07-15 起，DjVuLibre 与 Tesseract 的发行方式由
> [ADR 0002](0002-bundled-native-runtime.md) 取代；PDFium 决策仍然有效。

为降低默认 Windows 安装包的许可证与部署风险，本轮采用：

### PDF 渲染：PyMuPDF → pypdfium2 / PDFium

- 生产运行时移除 `import fitz`；
- 改用 **pypdfium2**（BSD-3-Clause，封装 Google PDFium，BSD-3）；
- 用于：页数、页面渲染、DPI 换算、页面图片输出、bbox 像素适配。

### Tesseract：可选二次复核

- RapidOCR 为主识别（Apache-2.0），开箱即用；
- Tesseract（Apache-2.0）为**可选**二次复核；
- Tesseract 缺失时：主 OCR 仍产出结果，二次复核状态标 `skipped_unavailable`，
  任务不失败，UI 显示「未执行 Tesseract 二次复核」。

### DjVuLibre：可选外部组件

- 默认安装包**不直接捆绑** DjVuLibre 二进制（除非完成完整 GPL 合规材料）；
- DJVU/DJV 在检测到外部 DjVuLibre 后可用；缺失时创建任务前提示；
- PDF 与 Demo 不受影响。

### 项目根许可证

项目清单已经统一声明 MIT。HR-04 仅将缺失的根目录 MIT 全文与既有
`package.json`、`engine/pyproject.toml` 声明同步，并将该文本加入发行包；
这不是重新选择许可证或改变外部契约。

## 备选路线（未采纳为本轮默认，保留）

1. **AGPL 合规路线**：保留 PyMuPDF，履行 AGPL 对应源码披露义务；
2. **商业授权路线**：购买 PyMuPDF 商业许可证；
3. **DjVuLibre 随包**：完成 GPL 评估 + 满足义务后直接分发；
4. **应用内组件安装器**：用户确认后 HTTPS 下载 + SHA-256 校验 + 原子安装。

## 未决法律问题

- pypdfium2 对 PDFium 二进制的再分发条款（BSD-3，需保留版权声明）；
- RapidOCR 工程代码为 Apache-2.0，但上游声明模型版权归百度，公开再分发需审核；
- DjVuLibre Windows 构建内原生 DLL 与对应源码、声明的关系。

公开发布前必须通过
[`docs/compliance/public-release-license-gate.md`](../compliance/public-release-license-gate.md)
定义的技术与人工门禁；这些门禁不构成法律意见。
