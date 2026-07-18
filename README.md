# ArchiveLens

> 本地档案 OCR 检索与校对桌面工具 —— 在 PDF / DJVU / DJV / TIFF / JPEG / PNG 中定位用户指定的文字或词语。

**文档内容默认在本机处理，不上传网络。**

---

## 当前状态

当前版本为 **v0.1.0-alpha.11 Desktop Alpha**，支持任务级用户自定义检索词。

| 能力 | 状态 | 证据 |
| --- | --- | --- |
| Python Engine 项目化（`engine/`） | ✅ | 正式包 + pyproject + lock |
| JSONL Sidecar IPC（TS↔Python） | ✅ | Protocol v3 + Python/TS 共享契约 |
| Electron Main/Preload/Renderer 安全骨架 | ✅ | typecheck + build + 生命周期 E2E |
| Sidecar 端到端握手 | ✅ | `engine.ready` + `app.info` + 主窗口 |
| Worker/Task 真实状态机（修复残留 checkpoint 误判） | ✅ | checkpoint / sequence / migration 回归 |
| Engine PyInstaller one-folder 打包 | ✅ | 355MB exe 独立 serve 通过 |
| 生命周期关闭/恢复自动化 | ✅ | 14 个 Playwright lifecycle/recovery E2E |
| HTML 离线审阅报告 | ✅ | 单文件整页图片、命中标注、筛选分页、A4 打印与真实 OCR fixture 离线回归 |
| electron-builder 安装包/portable | ✅ 配置完成 | 仅接受同一候选 SHA 的 clean rebuild 产物 |
| 正式发布证据链 | ✅ 自动校验 | manifest / SHA256SUMS / release-chain |
| 任务中心与任务上下文 | ✅ | 服务端搜索/分页 + URL/本地持久化上下文 |
| 原文件级高清校对与古籍阅读方向 | ✅ | 源文件无损页面证据 + PDF 动态重渲染 + 横排/竖排上下文 |
| 失败恢复与诊断 | ✅ | 结构化失败明细 + 影响/建议 + 日志入口 |
| 校对与导出保护 | ✅ | 备注自动保存 + 系统/人工状态分离 + 应用内阶段性导出确认 |
| 图片档案扫描 | ✅ | TIFF（含多页）/ JPEG / PNG，支持混合任务与创建期安全校验 |
| 文件夹扫描预检 | ✅ | 可取消；统计格式、页数和磁盘；不跟随链接；大任务软警告确认 |

详见 [docs/architecture.md](docs/architecture.md) 与最终阶段报告。

## 快速开始（开发）

需 Python 3.11 与 Node 24（最低 Node 22.13，用于兼容 `pnpm@11.10.0`）。

```bash
# Python Engine（开发期直接用解释器，无需打包）
python -m pip install -r engine/requirements-lock.txt

# 运行 Engine 测试并执行覆盖率回退门禁
python scripts/run-python-coverage.py

# 桌面端
pnpm install
pnpm dev                # 启动 Electron（需设 AL_ENGINE_DEV 指向 python.exe）
```

`AL_ENGINE_DEV` 指向 Python 解释器时，Electron 以 `python -m archivelens_engine serve` 启动 Sidecar，无需 PyInstaller 产物。

## 架构

```
Renderer (React)  ──window.archiveLens──▶  Preload (contextBridge)
                                            │ ipcRenderer.invoke
                                            ▼
                                       Electron Main
                                            │ child_process.spawn（参数数组，shell:false）
                                            ▼
                                Python Engine（JSONL stdin/stdout）
                                            ▼
                                userData（SQLite / pages / crops / logs）
```

安全默认：`nodeIntegration:false` / `contextIsolation:true` / `sandbox:true` / `webSecurity:true`。Renderer 不接触 `fs` / `child_process` / 通用 `ipcRenderer`。详见 [docs/architecture.md](docs/architecture.md)。

## 测试

```bash
# Engine（Python，全量测试 + 覆盖率预算）
python scripts/run-python-coverage.py

# Desktop / IPC（真实 ESLint + 类型检查）
pnpm lint

# Desktop Vitest（全量测试 + 覆盖率预算）
pnpm test:coverage

# 构建后检查 Renderer/Main/Preload 原始与 gzip 体积预算
pnpm build
pnpm check:bundle
```

门槛基于当前真实基线，集中记录在 `scripts/quality-budgets.json`。覆盖率和体积摘要写入
gitignored 的 `coverage/`；门禁用于发现回退，不代表全仓测试已经充分。

## 打包

```bash
# Engine → dist/engine/win-x64/archivelens-engine.exe（PyInstaller one-folder）
pwsh scripts/build-engine.ps1

# 完整离线原生组件（构建期下载并校验，最终用户不联网）
pnpm prepare:native

# Desktop 完整安装包（自动准备原生组件）
pnpm --filter @archivelens/desktop dist
```

> ⚠️ 本地 `electron-builder` 可能因 pnpm symlink 导致 app-builder 重新下载 Electron 失败。建议在 CI（`windows-latest`）或 npm 环境执行。详见 [docs/packaging.md](docs/packaging.md)。

## 隐私

默认不上传文档 / OCR 内容 / 遥测；不加载远程网页。CSP `connect-src 'self'` 禁止公网请求。数据库、OCR 原文、索引、页面图片、校对备注和导出**默认以本地明文保存**，本地处理不等于应用级加密。数据位置、保留、卸载、清理与威胁模型详见 [docs/privacy-and-local-data.md](docs/privacy-and-local-data.md)。

## 许可证

MIT（见 [LICENSE](LICENSE)）。第三方组件清单见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
生产包不包含 PyMuPDF/fitz；PDF 渲染使用 pypdfium2/PDFium。Tesseract、四个简繁中文 tessdata_fast 模型与 DjVuLibre 命令行组件均随完整离线安装包分发，详见 [docs/native-dependencies.md](docs/native-dependencies.md)。
TIFF、JPEG、PNG 使用随 Engine 安装的 Pillow 解码；多页 TIFF 的每个 Frame 作为一个页面处理，原始图片不会被修改。

## Alpha 限制（必读）

- 版本 `0.1.0-alpha.11`，**非稳定版**，仅供早期试用与反馈；
- 新建任务输入 1～32 个 Unicode code point 的检索文字或词语；仅移除首尾 ASCII SPACE（U+0020），按 NFC 规范化后进行区分大小写的精确行内匹配；支持重叠匹配，不支持正则、通配符或跨 OCR 行匹配；
- 安装包**未签名**，Windows SmartScreen 可能提示「未知发布者」，需手动「仍要运行」；
- 仅支持 Windows 10/11 x64；
- 完整安装包内置 Tesseract、DjVuLibre 与简繁中文语言包，安装后无需另外下载；发布前仍须完成第三方许可证人工复核；
- userData 位于 `%APPDATA%\ArchiveLens`（安装版与 Portable 默认使用同一 Windows userData）；
- 卸载默认保留 userData（任务历史 / 校对 / 数据库）；
- Alpha10 已完成任务保留“约/約”历史语义；无法验证页进度的旧未完成任务标记 `LEGACY_TASK_REQUIRES_REVIEW`，保留旧结果但禁止自动恢复，用户需创建新任务重新扫描。

用户流程见 [docs/user-guide.md](docs/user-guide.md)，数据库兼容策略见 [docs/migration.md](docs/migration.md)。
