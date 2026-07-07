# 原生依赖

ArchiveLens OCR 依赖原生组件。**本轮未随安装包分发**——许可证合规是发布前阻塞（见 [../THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)）。

## 当前状态

packaged Engine 依赖宿主已安装的原生工具：

- Tesseract（`C:\Program Files\Tesseract-OCR`）
- DjVuLibre（`C:\Program Files (x86)\DjVuLibre`，提供 `ddjvu` / `djvused`）
- tessdata 语言包（`chi_sim` / `chi_tra` 等）

`diagnostics.run` 在缺组件时返回 `FAIL` / `WARN` 并给出影响与处理建议；PDF 扫描不依赖 DjVuLibre，DJVU 扫描依赖之。

## 许可证阻塞（发布前必须解决）

| 依赖 | 许可证 | 问题 |
| --- | --- | --- |
| PyMuPDF | AGPL-3.0 | 传染性；需源码披露合规 / 商业授权 / 替换为宽松许可库 |
| DjVuLibre | GPL-2.0 | 传染性；需评估随包影响或动态链接 / 应用内安装 |
| RapidOCR 模型 / tessdata | 需核实 | 逐文件确认来源与许可证 |

**任务 §二十二：不得在未解决许可证前直接打包这些依赖。本轮遵守——原生依赖未随包。**

## 合法分发方案（下一迭代）

1. PyMuPDF AGPL 决策（三选一）：履行 AGPL 源码义务 / 购买商业授权 / 替换库；
2. DjVuLibre：评估 GPL 影响，或维持「应用内安装」；
3. 模型 / 语言包核实后随 `resources/tessdata/` 与 `resources/models/` 分发；
4. 或实现**应用内组件安装器**：HTTPS 下载 + SHA-256 校验 + 用户显式确认 + 原子安装 + 失败可重试（不得静默下载）。

Engine 配置解析优先级（实现后）：打包资源目录 → 用户配置 → 环境变量 → PATH → 常见安装目录；**生产不优先使用开发机全局安装**。
