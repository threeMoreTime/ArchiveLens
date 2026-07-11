# OCR Fixtures

这些 PDF 是真实 pypdfium2/PDFium + RapidOCR 回归输入，不包含文本层，也不注入假 OCR 结果。

生成命令：

```powershell
python scripts/generate-ocr-fixtures.py
```

生成器使用 Windows 系统 `simhei.ttf`（SimHei 5.05，SHA-256 `9b1959db3b3abeb7efdaec26edf7dfe871a6039de8d614af7248575207be629e`）栅格化文字。字体文件不提交仓库，也不进入发布包；PDF 只包含栅格图像。`expected.json` 固定页面尺寸、DPI、字号、坐标、PDF metadata、文件哈希与精确预期。

Source/CI 测试只消费已提交 PDF，不依赖 runner 安装 SimHei。重新生成 fixture 时必须使用匹配字体哈希和锁定的 Pillow 版本，并验证两次生成 SHA-256 完全一致。
