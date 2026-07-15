# Offline Format Fixtures

本目录由 `scripts/generate-offline-format-fixtures.py` 生成，用于验证完整离线安装包对 PDF、3 页 DJVU、2 页 TIFF、JPEG、PNG 以及简繁中文横排/竖排内容的读取与渲染能力。

样本只包含 ArchiveLens 生成的匿名仿古档案文字。Windows SimHei 字体仅用于把字形栅格化到测试图片，字体程序不进入仓库或安装包。`expected.json` 记录生成器、文件页数和逐文件 SHA-256。

重新生成前先安装锁定的生成工具并准备原生组件，然后执行：

```powershell
python -m pip install -r scripts/requirements-fixtures.txt
pnpm install --frozen-lockfile
pnpm prepare:native
python scripts/generate-offline-format-fixtures.py
```

重新生成后必须验证两次生成哈希一致，并渲染检查 PDF 与 DJVU 页面是否清晰、完整、无裁切。
