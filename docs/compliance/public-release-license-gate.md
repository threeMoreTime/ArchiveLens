# 公开发布许可证技术门禁

本门禁落实 HR-04：ArchiveLens 继续内置锁定版本的 DjVuLibre，但任何公开发布
都必须先具备可复现的零成本技术合规证据。该流程不购买法律服务、证书、商店或
托管服务，也不把技术检查描述为法律意见。

## 门禁层级

1. **源码技术门禁**：验证项目 MIT 许可证、第三方声明、原生依赖锁、DjVuLibre
   GPL 文本与对应源码配置，以及发布验证脚本之间保持一致。
2. **打包技术门禁**：验证实际 `resources` 目录包含 ArchiveLens 许可证与声明、
   DjVuLibre GPL 文本和对应源码归档、锁文件、RapidOCR 模型清单，以及
   ONNX Runtime 的许可证和第三方声明。
3. **公开发布人工门禁**：针对冻结候选 SHA 填写
   `public-release-license-approval.json`。所有决定项必须为 `true`、阻塞列表必须
   为空，并由真实审核人记录时间。默认文件明确为未批准。
4. **正式发布授权**：即使许可证人工门禁通过，仍需另行取得明确的正式发布授权；
   本文件和脚本不能替代该授权。

## 命令

源码技术检查：

```powershell
python scripts/verify-license-compliance.py --mode source
```

打包技术检查：

```powershell
python scripts/verify-license-compliance.py `
  --mode packaged `
  --resources-root apps/desktop/release/win-unpacked/resources `
  --candidate-sha <冻结候选完整 SHA>
```

公开发布前的严格检查：

```powershell
python scripts/verify-license-compliance.py `
  --mode packaged `
  --resources-root apps/desktop/release/win-unpacked/resources `
  --candidate-sha <冻结候选完整 SHA> `
  --require-public-approval
```

默认审核记录会让最后一条命令失败，这是预期的 fail-closed 行为，不得通过删除
检查、清空阻塞项或伪造审核信息绕过。

## 当前必须人工复核的证据

- SourceForge 的 `DjVuLibre-3.5.29_DjView-4.12_Setup.exe` 与
  `djvulibre-3.5.29.tar.gz` 已分别固定来源与 SHA-256，但 Windows 构建所含
  `libjpeg.dll`、`libtiff.dll`、`libz.dll` 与对应源代码关系仍需人工确认。
- DjVuLibre 的 GPL-2.0 文本和 3.5.29 源码归档已随包；是否满足目标发行地区和
  发行方式的全部义务仍需人工判断。
- `rapidocr-onnxruntime` 1.4.4 的项目元数据和上游仓库标记 Apache-2.0，但上游
  同时声明 OCR 模型版权归百度；公开再分发模型前必须人工确认。
- 技术门禁会记录实际 ONNX 模型文件名与 SHA-256，但哈希证据只证明“分发了什么”，
  不证明“有权分发”。

## 零成本边界

- 不使用付费法律服务、付费许可证扫描 SaaS、付费签名、付费托管或付费 CI。
- 使用仓库脚本、Python 标准库、现有 CI runner 和上游公开材料。
- 如果无法在零成本条件下形成可信结论，公开发布保持阻塞，不降低许可证或发布标准。

本门禁是工程证据与人工审核载体，**不构成法律意见或合规保证**。
