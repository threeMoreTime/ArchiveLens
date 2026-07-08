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
echo '{"protocol_version":1,"request_id":"r1","method":"app.info","params":{}}' \
  | dist/engine/win-x64/archivelens-engine.exe serve
# → engine.ready 事件 + app.info success（python_executable 指向 exe 自身）
```

### 待纳入

- [ ] tessdata（简繁体语言包）随 extraResources 分发或应用内安装（当前 exe 未绑定，`diagnostics.run` 显示语言包 FAIL/WARN）；
- [ ] Tesseract / DjVuLibre 随包分发或应用内安装（任务 §二十六）；
- [ ] `THIRD_PARTY_NOTICES.md` 许可证清单。

## Electron 打包（配置就绪，本地受阻 ⚠️）

```bash
pnpm --filter @archivelens/desktop dist
```

`apps/desktop/electron-builder.yml` 已配置：

- `appId: io.archivelens.desktop`；
- NSIS 安装器（per-user、可卸载、默认保留用户数据）；
- portable；
- `extraResources`：`dist/engine/win-x64` → `engine/win-x64`（Engine 随包分发）。

### 当前发布闭环要求

- 开发 worktree 全量回归通过后，才允许升级版本并冻结候选 SHA；
- clean worktree 必须重新安装依赖、重跑测试、重建 Engine / win-unpacked；
- 仅在 clean Engine、clean OCR、clean lifecycle E2E 全部通过后，才允许生成 Setup / Portable；
- 最终交付必须附带 `release-manifest.json`、`SHA256SUMS.txt` 与 `verify-release-chain.ps1` 输出。

### 安装包产物（目标）

```
ArchiveLens-0.1.0-alpha.9-x64-setup.exe       (NSIS)
ArchiveLens-0.1.0-alpha.9-x64-portable.exe    (portable)
SHA256SUMS.txt
```

> v0.1.0-alpha.9 未签名：EXE 属性已含产品名 / 版本，但无代码签名证书。架构上 `cscLink` / `cscKeyPassword` 已预留，不得将私钥提交仓库。

## 发布前检查清单（任务 §三十四）

- [ ] Python tests / Desktop tests / IPC contract
- [ ] Electron E2E / packaged smoke / installer smoke
- [ ] 包内无用户数据 / 开发机绝对路径 / `.venv` / `node_modules` / Git 历史
- [ ] 许可证 / 校验和（SHA-256）
