# 打包

ArchiveLens 桌面版交付物由两部分组成：

1. **Python Engine**（PyInstaller one-folder）→ `engine/win-x64/archivelens-engine.exe`
2. **Electron App**（electron-builder）→ 内含 Engine（extraResources）+ Renderer

## Engine 打包（已验证 ✅）

```bash
pwsh scripts/build-engine.ps1
```

- 模式：one-folder（不盲目追求 one-file，便于审计模型 / 原生 DLL）；
- `--collect-all rapidocr_onnxruntime` / `--collect-all onnxruntime` /
  `--collect-all opencc`：确保模型、OpenCC 字典、许可证与原生 DLL 纳入；
- `--add-data ...;archivelens_models`：只加入锁定的 PP-OCRv6 small 文字识别模型；
- 打包后删除 RapidOCR wheel 自带且不再使用的 PP-OCRv4 文字识别模型，并验证
  包内只存在一个 PP-OCRv6 small 文字识别模型；
- 产物：`dist/engine/win-x64/archivelens-engine.exe`（约 355MB）；
- smoke 验证（已通过）：

```bash
echo '{"protocol_version":3,"request_id":"r1","method":"app.info","params":{}}' \
  | dist/engine/win-x64/archivelens-engine.exe serve
# → engine.ready 事件 + app.info success（python_executable 指向 exe 自身）
```

### 完整离线原生组件

```powershell
pnpm prepare:native
```

该步骤按 `scripts/native-dependencies.lock.json` 下载并校验 PP-OCRv6 small、
Tesseract、四个简繁中文 `tessdata_fast` 模型和 DjVuLibre，将结果写入
`dist/native/win-x64`。使用 `-Offline` 时只接受已校验缓存；最终用户运行时
不存在下载逻辑。

## Electron 打包

```bash
pnpm --filter @archivelens/desktop dist
```

`apps/desktop/electron-builder.yml` 已配置：

- `appId: io.archivelens.desktop`；
- NSIS 安装器（per-user、可卸载、默认保留用户数据）；
- Portable（默认与安装版共用 `%APPDATA%\ArchiveLens`，关闭 Portable 不自动删除数据）；
- `extraResources`：Engine、Tesseract、tessdata、DjVuLibre、ArchiveLens MIT 文本、
  第三方声明、原生许可证与 DjVu 对应源码均随包分发。

### 发布闭环要求

- `pnpm gate:release-local` 是 Windows 10/11 x64 的零成本、本地、非发布候选门禁；
- 门禁只接受 clean worktree，并冻结完整候选 SHA，重新安装锁定依赖、运行源码与
  E2E 回归、真实 ESLint、TypeScript/Python 覆盖率预算、构建体积预算，重建
  Engine / Setup / Portable、执行安装/便携版 smoke 和同 SHA 校验；
- 已具备校验缓存时可运行 `pnpm gate:release-local -- -OfflineNative`，原生组件
  准备阶段完全离线且仍逐项验证 SHA-256；
- `verify-license-compliance.py` 的源码与打包技术门禁必须通过；
- 门禁不会 push、创建 PR、合并、购买签名、部署或发布。公开发布必须另外通过
  绑定冻结候选 SHA 的许可证人工门禁，且仍需独立的正式发布授权；
- 当前没有上一可信稳定版安装器时，跨版本升级与回滚必须标记 `NOT_VERIFIED`，
  不得据此宣称稳定发布就绪；从历史提交在当前机器重建的安装器可用于兼容性演练，
  但不能替代当年发布制品的来源证明；
- 历史 `alpha.10` 已实证会改写未来 schema，绝不能用于直接打开当前数据。降级必须
  在应用退出后恢复升级前、与旧版本 schema 匹配且校验通过的备份；
- 安装/卸载/Portable 的本地明文、保留和清理合同见
  [`privacy-and-local-data.md`](privacy-and-local-data.md)；卸载配置必须保持
  `deleteAppDataOnUninstall: false`，除非以后经过独立产品与数据安全审核；
- 详细步骤、证据和阻塞规则见 [`release-gate.md`](release-gate.md)。

### 安装包产物（目标）

```
ArchiveLens-0.1.0-alpha.11-x64-setup.exe      (NSIS)
ArchiveLens-0.1.0-alpha.11-x64-portable.exe   (portable)
SHA256SUMS.txt
```

> v0.1.0-alpha.11 是未签名 Alpha：EXE 属性包含产品名与版本，但 Windows SmartScreen 可能显示未知发布者。不得将签名证书或私钥提交仓库。

## 发布前检查清单（任务 §三十四）

- [ ] Python tests + coverage / Desktop tests + coverage / ESLint / bundle budget / IPC contract
- [ ] Electron E2E / packaged smoke / installer + portable smoke
- [ ] 包内无用户数据 / 开发机绝对路径 / `.venv` / `node_modules` / Git 历史
- [ ] 许可证技术门禁 / 人工许可证审核 / 校验和（SHA-256）
- [ ] 使用上一可信稳定版完成真实升级与回滚验证

真实 OCR fixture 使用 Windows 系统 SimHei 5.05 生成图片 PDF；字体文件不进入仓库或发布包。生成脚本固定页面参数与 PDF metadata，`expected.json` 记录字体及每个 fixture 的 SHA-256。

完整离线格式 fixture 的生成依赖固定在 `scripts/requirements-fixtures.txt`；这些工具只用于生成测试数据，不进入生产运行时。
