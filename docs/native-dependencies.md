# 原生依赖

ArchiveLens 完整安装包在 Windows x64 上离线提供全部文档格式与二次识别能力。运行时不会下载组件，也不依赖系统 PATH、`Program Files` 中的同名工具或用户手工配置。

## 包内布局

| 能力 | 包内位置 | 版本与许可证 |
| --- | --- | --- |
| Tesseract OCR | `resources/native/tesseract/` | 5.5.0.20241111，Apache-2.0 |
| 简繁中文模型 | `resources/native/tesseract/tessdata/` | `tessdata_fast` 固定提交，Apache-2.0 |
| DjVuLibre | `resources/native/djvulibre/` | 3.5.29，GPL-2.0-only |
| PDF / 图片 | Python Engine 内 | PDFium、RapidOCR、ONNX Runtime、Pillow |

随包模型为 `chi_sim`、`chi_tra`、`chi_sim_vert`、`chi_tra_vert`。DjVuLibre 仅通过 `ddjvu.exe` 与 `djvused.exe` 独立进程调用；对应 GPL 文本和 3.5.29 源码归档分别位于 `resources/licenses/` 与 `resources/sources/djvulibre/`。Tesseract 的主许可证、Windows 构建 AUTHORS 与上游构建 README 也位于 `resources/licenses/`。

## 可复现构建

`scripts/native-dependencies.lock.json` 固定所有下载地址和 SHA-256。执行：

```powershell
pnpm prepare:native
```

脚本使用 Windows 系统 `%SystemRoot%\System32\curl.exe` 下载并严格跟随 HTTPS 重定向，再通过 `7zip-bin-full` 直接提取已校验的 NSIS 制品；不运行上游安装器、不提权、不写注册表。下载先写入临时文件，只有 SHA-256 完全匹配时才进入缓存。已有缓存可通过 `-Offline` 完全离线重建。任何下载哈希、运行树哈希、组件版本或语言包缺失都会终止构建。

生产主进程通过 `AL_TESSERACT_CMD`、`AL_TESSDATA_DIR`、`AL_DJVU_BIN_DIR` 强制注入包内路径；开发模式继续允许显式环境变量覆盖。

## 发布要求

- `release-manifest.json` 必须记录组件版本、来源、许可证、文件哈希和运行树哈希。
- `verify-release-chain.ps1` 必须证明 clean 构建、win-unpacked、Setup 和 Portable 的原生组件一致。
- `python scripts/verify-license-compliance.py --mode packaged --resources-root <resources> --candidate-sha <sha>`
  必须验证安装包内的 ArchiveLens 许可证、第三方声明、DjVuLibre GPL 文本与对应源码、
  RapidOCR 模型清单和 ONNX Runtime 许可材料。
- 正式公开发布前还必须使用 `--require-public-approval`，并针对冻结候选 SHA 完成
  `docs/compliance/public-release-license-approval.json`。默认审核记录为未批准。
- 许可证审核通过不等于批准正式发布；本说明和自动检查不构成法律意见。

## 离线验证

`python scripts/offline-native-smoke.py --resources-root <resources>` 会清空原生工具子进程可见的宿主 PATH，验证四个中文模型、PDF/DJVU/TIFF/JPEG/PNG 的页数与逐页渲染，以及简繁中文 Tesseract 识别。测试集由 `scripts/generate-offline-format-fixtures.py` 生成，不含真实档案数据。
