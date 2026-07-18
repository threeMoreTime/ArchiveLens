# IPC 协议

Electron Main ↔ Python Engine 之间的通信协议：**UTF-8 JSON Lines over stdin/stdout**。

- 每条消息一行，完整 JSON 对象；
- `stdout` **只**输出协议消息；普通日志走 `stderr` / 日志文件；
- `protocol_version` 当前为 `3`，TS（`packages/ipc-schema/src/index.ts`，Zod）与 Python（`archivelens_engine/protocol.py`）**必须一致**；v3 增加文件夹预检这一新界面的必需调用链，不能与 v2 引擎混用；
- 不兼容版本必须显式失败（`PROTOCOL_MISMATCH`），不得静默继续。

## 请求

```json
{ "protocol_version": 3, "request_id": "<uuid>", "method": "app.info", "params": {} }
```

## 成功响应

```json
{ "protocol_version": 3, "request_id": "<uuid>", "ok": true, "result": {} }
```

## 错误响应

```json
{ "protocol_version": 3, "request_id": "<uuid>", "ok": false,
  "error": { "code": "DEPENDENCY_MISSING", "message": "缺少繁体中文 OCR 语言包", "details": {} } }
```

`request_id` 在错误响应中允许为 `null`（如无效 JSON 场景）。Main 侧对 `null` 仅记录、不关联 pending。

## 事件（Server → Main 单向）

```json
{ "protocol_version": 3, "event": "task.progress", "task_id": "<uuid>",
  "payload": { "processed_pages": 125, "total_pages": 500 } }
```

启动事件 `engine.ready` 握手：

```json
{ "protocol_version": 3, "event": "engine.ready", "task_id": null,
  "payload": { "engine_version": "0.1.0", "protocol_version": 3 } }
```

Main 只有在外层和 payload 的 `protocol_version` 都严格为整数 `3`，且
`engine_version` 为非空字符串时才进入 ready。任何合法 JSON 但 schema/版本不兼容的
消息都会触发 `PROTOCOL_MISMATCH`、拒绝 startup/pending 请求并终止 Sidecar。

## 错误码

`VALIDATION_ERROR` · `PATH_NOT_FOUND` · `PERMISSION_DENIED` · `DEPENDENCY_MISSING` · `ENGINE_START_FAILED` · `ENGINE_CRASHED` · `IPC_TIMEOUT` · `TASK_NOT_FOUND` · `TASK_STATE_CONFLICT` · `DATABASE_ERROR` · `EXPORT_FAILED` · `DISK_SPACE_LOW` · `UNSUPPORTED_FILE` · `PROTOCOL_MISMATCH` · `UNKNOWN_METHOD` · `UNKNOWN_ERROR` · `SOURCE_EVIDENCE_UNAVAILABLE` · `SOURCE_FILE_CHANGED` · `PAGE_RENDER_LIMIT_EXCEEDED` · `OCR_CORPUS_UNAVAILABLE` · `PREFLIGHT_STALE`

## 已实现方法

### `tasks.create`

```json
{
  "source_dir": "C:\\档案",
  "search_text": "档案管理"
}
```

文件夹来源兼容旧调用（可省略 `source_type` 或传入 `"folder"`）。单文件和多文件通过同一任务创建接口传入文件清单：

```json
{
  "source_type": "files",
  "source_files": ["C:\\档案\\甲.pdf", "D:\\馆藏\\乙.djvu"],
  "search_text": "档案管理"
}
```

文件清单按规范化绝对路径自动去重，去重后必须有 1–200 个文件；可跨目录并混合格式。每个路径必须存在、是可读取的普通文件，且扩展名为 `.pdf`、`.djvu`、`.djv`、`.tif`、`.tiff`、`.jpg`、`.jpeg` 或 `.png`。图片在创建任务时校验扩展名与真实格式、尺寸和页数；单页最多 2 亿像素、最长边 30000 像素，多页 TIFF 最多 5000 页，动态 PNG/APNG 不受支持。任一文件无效时返回 `VALIDATION_ERROR` 与 `invalid_files`，不会创建部分任务。任务响应包含 `source_kind`、`source_label`，文件清单任务还包含 `source_files`；原有 `source_dir` 保留以兼容旧调用。

文件夹来源在创建前使用 `tasks.preflight / tasks.preflightGet / tasks.preflightCancel` 管理可取消的临时预检作业。结果包含支持/不支持/重复文件数、格式分布、总字节、已知页数、无权限或无效文件、跳过的链接、任务工作区磁盘可用量、保守空间估算、警告、阻塞项和 `scan_token`。预检默认不跟随 junction、reparse point 或符号链接，来源路径自身的任一祖先包含链接时直接拒绝；超过 200 个文件是软警告而非硬上限。`tasks.create` 接受可选 `preflight_token` 与 `preflight_confirmed`，并在 Engine 内重新执行相同规则；目录快照变化返回 `PREFLIGHT_STALE`，磁盘不足返回 `DISK_SPACE_LOW`。创建成功后冻结安全文件清单，后台扫描不重新递归已跳过的目录。

`search_text` 为必填字段：仅移除首尾 ASCII SPACE（U+0020），再执行 NFC 规范化；
结果必须为 1～32 个 Unicode code point。内部及非 ASCII 空格保留；拒绝 Cc、Cs、
U+FEFF。匹配是区分大小写的精确连续子串，只在同一 OCR 行内查找；不支持正则或
通配符。创建后的检索词不可修改。`parallel_workers` 若提供，只允许整数 `1`。

| 方法 | 说明 | 状态 |
| --- | --- | --- |
| `app.info` | 引擎版本 / 协议版本 / python 路径 | ✅ |
| `diagnostics.run` | 环境自检（Tesseract / DjVu / 语言包 / RapidOCR / onnx） | ✅ |
| `tasks.preflight / preflightGet / preflightCancel` | 文件夹安全枚举、页数/空间估算、风险确认与取消 | ✅ |
| `tasks.*` / `results.*` / `search.*` / `review.*` / `export.*` / `exports.list` / `files.*` / `settings.*` | 见 `MethodNameSchema` | ✅ |

### `search.*`

任务内简繁字形检索使用五个 Python Sidecar 方法，全部只访问任务本地 SQLite 与经
指纹验证的来源文件，不向外联网：

| 方法 | 作用 |
| --- | --- |
| `search.corpusStatus` | 返回 `not_built / building / ready / partial / failed / legacy_requires_reocr`、模型身份和已索引页数 |
| `search.execute` | 按 `query_text` 与 `simplified / traditional / both` 执行分层检索，并原子保存会话及全部命中 |
| `search.sessions` | 返回同一任务最近的持久化检索历史 |
| `search.hits` | 按 `task_id + search_session_id` 校验会话归属后，分页返回原文、解析文本、层级、字形、坐标和 Top-K 证据 |
| `search.preparePageImage` | 根据 `search_hit_id` 准备经来源 SHA-256 验证的本地页面图像，不接收或返回绝对路径 |

`search.execute` 仅接受已处于 `ready` 或 `partial` 的语料。旧任务返回
`OCR_CORPUS_UNAVAILABLE` 和 `requires_reocr=true`，Renderer 必须引导用户显式
重新 OCR，不得静默迁移。命中层级固定为 `raw_exact → context_resolved →
variant_graph → ocr_top_k`；最后一层固定标记为候选待人工核查。

### `review.preparePageImage`

该方法是现行协议的增量能力，用于按工作台实际显示尺寸准备经源文件指纹验证的无损页面证据：

```json
{
  "task_id": "task_...",
  "occurrence_id": "occ_...",
  "target_css_width": 960,
  "target_css_height": 1280,
  "device_pixel_ratio": 2
}
```

响应包含 `asset_relpath`、`asset_version`、实际 `pixel_width` / `pixel_height`、`width_100_css` / `height_100_css`、`source_kind`、`fidelity` 和可选 `overscale_warning`。PDF 按目标尺寸动态渲染；位图和 DjVu 返回原生解码像素。任务级缓存位于扫描目录的 `evidence/` 下，不修改主任务数据库 schema。旧任务只有在 `run/report.db` 中存在扫描时 SHA-256 且当前源文件校验一致时才会生成新证据；已经生成并绑定扫描时指纹的页面在源文件随后移动或变化后仍可读取。

### 任务与导出列表扩展

- `tasks.list` 接受 `limit`（1～100）、`offset`、可选 `status` 和可选 `query`；响应包含 `items`、`limit`、`offset` 与符合筛选条件的 `total`。`query` 在任务名称、来源目录、来源标签、文件清单展示名与检索词中做本地包含匹配。
- `tasks.get` 除任务摘要外返回最多 100 条结构化 `failures`，供任务页解释部分成功或失败原因。
- `tasks.delete` 仅接受已完成、失败或已取消的任务；调用方必须先取消其他状态的任务。删除是幂等的持久化清理作业：失败时任务保留并返回可诊断状态，重复调用继续清理。它只清理本地任务记录、扫描结果、校对/导出记录和应用生成的页面图片，不会删除任何来源文件。
- `tasks.cleanupTarget` 返回失败清理作业的安全残留目录或 `null`，供 Main 打开目录；不接受 Renderer 提供任意路径。
- `exports.list` 按最近写入顺序返回指定任务的持久化导出记录；导出文件仍保存在该任务本地工作区。
- `storage.cleanupTemporary` 不接受路径或其他参数，只重试数据库登记的终态导出临时残留；活动作业、未知目录、任务数据、成功导出和来源文件不在清理集合中。结果只返回尝试、成功、失败、跳过活动作业和剩余计数。
- Renderer 打开任务/导出目录使用 Main 按 `userData + task_id/export_id` 推导的受控入口；不再暴露可传任意绝对路径的通用文件夹 IPC。
- `exports.create/get/listJobs/cancel/retry` 管理持久化 JSON/HTML 导出作业。`listJobs` 使用 `limit/offset/total` 分页；全局最多一个作业写入，其余合法请求保持 `queued`。取消返回 `{export_id,status}`；失败、取消和中断作业可用新 `export_id` 重试，成功作业不可重试。

### 本地显示设置

- `settings.get` 与 `settings.update` 是 Renderer 到 Electron Main 的本地 IPC，不经过 Python Sidecar。
- 设置文件当前版本为 3；读取 v1/v2 时只补入默认的 `search_script_scope="both"`，不会改写 OCR 数据。
- 校对高亮样式由 6 位十六进制 `color` 和 `0.1`～`0.6` 的 `opacity` 组成，保存在 `userData/settings.json`。
- 旧 `page_quality` 字段继续兼容解析，但读取和保存时统一归一为 `maximum`，不再影响页面渲染。
- `settings.update` 支持修改 `global` 全局默认，或按 `task_id` 保存/清除 `task` 覆盖；读取时返回全局值、任务覆盖和最终生效值。
- `settings.update` 还支持 `{ scope: "global", search_script_scope }`，取值为 `simplified | traditional | both`，默认 `both`；它只决定新检索会话的默认范围。
- `settings.update` 还支持 `{ scope: "document", task_id, document_id, orientation }`，其中 `orientation` 为 `up | right | down | left`。方向保存在任务覆盖项的 `page_orientations` 映射中，由同一 `document_id` 的全部命中共用；旧设置缺失该映射时按空映射读取。
- 删除任务时会清理对应的任务高亮、扫描上下文和页面方向覆盖，但不会影响全局设置或其他任务。页面方向只影响校对工作台中央出处页，不进入 Python IPC、OCR 坐标或离线导出。

## 健壮性保证

- Main 端 `JsonLineReader` 处理粘包 / 半行；
- 无效 JSON 仅记录，不响应、不崩溃；
- 未知方法 → `UNKNOWN_METHOD`；
- 任意 handler 异常 → `UNKNOWN_ERROR`，server 不退出；
- 请求支持超时（默认 30s）；Sidecar 退出时所有 pending 请求失败为 `ENGINE_CRASHED`；
- Main 将 Sidecar 异常广播给 Renderer。

## Legacy 未完成任务

从缺少可信 processed pages/checkpoint 的旧 schema 迁移时，任务会进入 `recoverable` 并设置 `LEGACY_TASK_REQUIRES_REVIEW`。`tasks.resume` 对该错误码 fail-closed：不伪造 checkpoint、不重新扫描、不删除旧 occurrence/review/note/export。Renderer 显示只读说明，并允许把原来源目录带入新任务页面。
