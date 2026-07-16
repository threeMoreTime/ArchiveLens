# 打包

ArchiveLens 桌面版交付物由两部分组成：

1. **Python Engine**（PyInstaller one-folder）→ `engine/win-x64/archivelens-engine.exe`
2. **Electron App**（electron-builder）→ 内含 Engine（extraResources）+ Renderer

## Engine 打包（已验证 ✅）

```bash
pwsh scripts/build-engine.ps1
```

- 模式：one-folder（不盲目追求 one-file，便于审计模型 / 原生 DLL）；
- `--collect-all rapidocr_onnxruntime` / `--collect-all onnxruntime`：确保模型与原生 DLL 纳入；
- 产物：`dist/engine/win-x64/archivelens-engine.exe`（约 355MB）；
- smoke 验证（已通过）：

```bash
echo '{"protocol_version":2,"request_id":"r1","method":"app.info","params":{}}' \
  | dist/engine/win-x64/archivelens-engine.exe serve
# → engine.ready 事件 + app.info success（python_executable 指向 exe 自身）
```

### 完整离线原生组件

```powershell
pnpm prepare:native
```

该步骤按 `scripts/native-dependencies.lock.json` 下载并校验 Tesseract、四个简繁中文 `tessdata_fast` 模型和 DjVuLibre，将结果写入 `dist/native/win-x64`。使用 `-Offline` 时只接受已校验缓存；最终用户运行时不存在下载逻辑。

## Electron 打包

```bash
pnpm --filter @archivelens/desktop dist
```

`apps/desktop/electron-builder.yml` 已配置：

- `appId: io.archivelens.desktop`；
- NSIS 安装器（per-user、可卸载、默认保留用户数据）；
- portable；
- `extraResources`：Engine、Tesseract、tessdata、DjVuLibre、ArchiveLens MIT 文本、
  第三方声明、原生许可证与 DjVu 对应源码均随包分发。

### 发布闭环要求

- 开发 worktree 全量回归通过后，才允许升级版本并冻结候选 SHA；
- clean worktree 必须重新安装依赖、重跑测试、重建 Engine / win-unpacked；
- 仅在 clean Engine、clean OCR、clean lifecycle E2E 全部通过后，才允许生成 Setup / Portable；
- `verify-license-compliance.py` 的源码与打包技术门禁必须通过；
- 公开发布必须另外通过绑定冻结候选 SHA 的许可证人工门禁，且仍需独立的正式发布授权；
- 最终交付必须附带 `release-manifest.json`、`SHA256SUMS.txt` 与 `verify-release-chain.ps1` 输出。

### 安装包产物（目标）

```
ArchiveLens-0.1.0-alpha.11-x64-setup.exe      (NSIS)
ArchiveLens-0.1.0-alpha.11-x64-portable.exe   (portable)
SHA256SUMS.txt
```

> v0.1.0-alpha.11 是未签名 Alpha：EXE 属性包含产品名与版本，但 Windows SmartScreen 可能显示未知发布者。不得将签名证书或私钥提交仓库。

## 发布前检查清单（任务 §三十四）

- [ ] Python tests / Desktop tests / IPC contract
- [ ] Electron E2E / packaged smoke / installer smoke
- [ ] 包内无用户数据 / 开发机绝对路径 / `.venv` / `node_modules` / Git 历史
- [ ] 许可证技术门禁 / 人工许可证审核 / 校验和（SHA-256）

真实 OCR fixture 使用 Windows 系统 SimHei 5.05 生成图片 PDF；字体文件不进入仓库或发布包。生成脚本固定页面参数与 PDF metadata，`expected.json` 记录字体及每个 fixture 的 SHA-256。

完整离线格式 fixture 的生成依赖固定在 `scripts/requirements-fixtures.txt`；这些工具只用于生成测试数据，不进入生产运行时。
