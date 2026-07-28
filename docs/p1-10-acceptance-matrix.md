# P1-10 发布候选与档案验收矩阵

## 候选信息

| 项 | 值 |
|---|---|
| 候选 SHA | `4da9523c1c6195dfaa9981f35ece2be56c53c58e` |
| 版本 | `0.1.0-alpha.11` |
| PROTOCOL_VERSION | 4 |
| 基线分支 | main (P1-8/P1-9 已合并) |

## 修改前发布链能力矩阵

| 能力 | 已有脚本 | CI 验证 | 本地门禁 | 最新 main 实证 | 风险 |
|---|---|---|---|---|---|
| Engine 构建 | `scripts/build-engine.ps1` | ✅ Packaged Smoke | ✅ release gate | ✅ dist/engine/win-x64/ | 低 |
| Setup 构建 | electron-builder | ✅ Packaged Smoke (win-unpacked) | ✅ release gate | ✅ apps/desktop/release/ | 低 |
| Portable 构建 | electron-builder | ✅ Packaged Smoke (win-unpacked) | ✅ release gate | ✅ apps/desktop/release/ | 低 |
| Setup smoke（安装/卸载） | `scripts/smoke-installer.ps1` | ❌ CI 只到 win-unpacked | ✅ release gate | ⚠️ 7月21日旧版 | 中 |
| Portable smoke | `scripts/smoke-portable.ps1` | ❌ CI 只到 win-unpacked | ✅ release gate | ⚠️ 7月21日旧版 | 中 |
| win-unpacked smoke | CI package-smoke job | ✅ | ✅ release gate | ✅ | 低 |
| 离线原生组件 smoke | `scripts/offline-native-smoke.py` | ✅ Packaged Smoke | ✅ release gate | ✅ | 低 |
| 八组 OCR smoke | `scripts/packaged-ocr-smoke.py` | ✅ Packaged Smoke | ✅ release gate | ✅ | 低 |
| 推理中退出 smoke | `scripts/shutdown-inference-smoke.py` | ✅ Packaged Smoke | ✅ release gate | ✅ | 低 |
| HTML 导出 smoke | `scripts/html-smoke.py` | ✅ Packaged Smoke | ✅ release gate | ✅ | 低 |
| 许可证门禁 | `scripts/verify-license-compliance.py` | ✅ Engine+Packaged | ✅ release gate | ✅ | 低 |
| Manifest 生成 | `scripts/generate-manifest.py` | ✅ Packaged Smoke | ✅ release gate | ✅ | 低 |
| 同 SHA 校验 | `scripts/verify-release-chain.ps1` | ✅ Packaged Smoke | ✅ release gate | ✅ | 低 |
| Authenticode | 无证书 | ✅ 记录未签名 | ✅ 记录未签名 | ✅ 未签名 | 已知限制 |
| 完整 Playwright E2E | CI lifecycle-e2e job | ✅ | ✅ release gate | ✅ | 低 |

### 关键风险
1. **CI 与本地门禁的证据断层**：CI package-smoke 验证 win-unpacked（非最终 Setup/Portable），Setup/Portable 真实安装验收只在本地 release gate 执行
2. **旧版产物**：本机已有 7月21日产物，但需基于 `4da9523c` 重新构建验证

## 现有 fixture 清单

### OCR fixtures（tests/fixtures/ocr/）
| fixture_id | 格式 | 页数 | 版面 | 退化 | 可提交 |
|---|---|---|---|---|---|
| custom-single | PDF | 1 | 简体横排 | 清晰 | ✅ |
| custom-double | PDF | 1 | 简体横排 | 清晰 | ✅ |
| custom-multi | PDF | 1 | 简体横排（多字） | 清晰 | ✅ |
| custom-english | PDF | 1 | 英文横排 | 清晰 | ✅ |
| custom-special | PDF | 1 | 简体横排 | 特殊字符 | ✅ |
| custom-no-hit | PDF | 1 | 简体横排 | 无命中 | ✅ |
| custom-repeat | PDF | 1 | 简体横排 | 重复词 | ✅ |
| custom-cross-line | PDF | 1 | 简体横排 | 跨行 | ✅ |
| legacy-pair | PDF | 1 | 繁体横排 | 约定式 | ✅ |
| mixed-multipage | PDF | 多页 | 混合 | 正常 | ✅ |
| rotated-page | PDF | 1 | 旋转 | 倾斜 | ✅ |
| simplified-horizontal | PDF | 1 | 简体横排 | 清晰 | ✅ |
| traditional-horizontal | PDF | 1 | 繁体横排 | 清晰 | ✅ |
| 中文 空格 # % | PDF | 1 | 简体横排 | 特殊文件名 | ✅ |

### 离线格式 fixtures（tests/fixtures/offline-formats/）
| fixture_id | 格式 | 可提交 |
|---|---|---|
| multipage.tiff | TIFF | ✅ |
| simplified-horizontal.png | PNG | ✅ |

### 真实档案（不入仓库）
| fixture_id | 格式 | 大小 | 来源 | 可提交 |
|---|---|---|---|---|
| 乾隆朝上谕档第1册 | PDF | 24MB | 用户合法持有 | ❌（不入仓库） |

### 缺失类别（需多轮补充）
| 类别 | 最低要求 | 当前 | 缺口 |
|---|---|---|---|
| DJVU/DJV | 3 | 0 | 3 |
| JPEG | 2 | 0 | 2 |
| 繁体竖排 | 3 | 0 | 3 |
| 双栏/多栏 | 3 | 0 | 3 |
| 低对比度 | 2 | 0 | 2 |
| 污渍/噪声 | 2 | 0 | 2 |
| 超长 Unicode 路径 | 2 | 0 | 2 |
| 加密 PDF | 1 | 0 | 1 |
| 损坏文件 | 2 | 0 | 2 |
| 大任务（300+页） | 1 | 0 | 1 |

## 验收标准

| 指标 | 目标 |
|---|---|
| 正常文件任务成功率 | 100% |
| 正常页面成功率 | ≥99% |
| 预期检索召回率 | ≥95% |
| 恢复后重复正式提交页 | 0 |
| 来源文件被修改 | 0 |
| JSON 导出缺失命中 | 0 |
| HTML 导出缺页 | 0 |
| Setup 卸载后残留进程 | 0 |
| Portable 退出后残留进程 | 0 |
| 数据库 integrity_check | PASS |
