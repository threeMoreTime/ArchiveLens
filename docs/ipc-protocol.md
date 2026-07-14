# IPC 协议

Electron Main ↔ Python Engine 之间的通信协议：**UTF-8 JSON Lines over stdin/stdout**。

- 每条消息一行，完整 JSON 对象；
- `stdout` **只**输出协议消息；普通日志走 `stderr` / 日志文件；
- `protocol_version` 当前为 `2`，TS（`packages/ipc-schema/src/index.ts`，Zod）与 Python（`archivelens_engine/protocol.py`）**必须一致**；
- 不兼容版本必须显式失败（`PROTOCOL_MISMATCH`），不得静默继续。

## 请求

```json
{ "protocol_version": 2, "request_id": "<uuid>", "method": "app.info", "params": {} }
```

## 成功响应

```json
{ "protocol_version": 2, "request_id": "<uuid>", "ok": true, "result": {} }
```

## 错误响应

```json
{ "protocol_version": 2, "request_id": "<uuid>", "ok": false,
  "error": { "code": "DEPENDENCY_MISSING", "message": "缺少繁体中文 OCR 语言包", "details": {} } }
```

`request_id` 在错误响应中允许为 `null`（如无效 JSON 场景）。Main 侧对 `null` 仅记录、不关联 pending。

## 事件（Server → Main 单向）

```json
{ "protocol_version": 2, "event": "task.progress", "task_id": "<uuid>",
  "payload": { "processed_pages": 125, "total_pages": 500 } }
```

启动事件 `engine.ready` 握手：

```json
{ "protocol_version": 2, "event": "engine.ready", "task_id": null,
  "payload": { "engine_version": "0.1.0", "protocol_version": 2 } }
```

Main 只有在外层和 payload 的 `protocol_version` 都严格为整数 `2`，且
`engine_version` 为非空字符串时才进入 ready。任何合法 JSON 但 schema/版本不兼容的
消息都会触发 `PROTOCOL_MISMATCH`、拒绝 startup/pending 请求并终止 Sidecar。

## 错误码

`VALIDATION_ERROR` · `PATH_NOT_FOUND` · `PERMISSION_DENIED` · `DEPENDENCY_MISSING` · `ENGINE_START_FAILED` · `ENGINE_CRASHED` · `IPC_TIMEOUT` · `TASK_NOT_FOUND` · `TASK_STATE_CONFLICT` · `DATABASE_ERROR` · `EXPORT_FAILED` · `DISK_SPACE_LOW` · `UNSUPPORTED_FILE` · `PROTOCOL_MISMATCH` · `UNKNOWN_METHOD` · `UNKNOWN_ERROR`

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

`search_text` 为必填字段：仅移除首尾 ASCII SPACE（U+0020），再执行 NFC 规范化；
结果必须为 1～32 个 Unicode code point。内部及非 ASCII 空格保留；拒绝 Cc、Cs、
U+FEFF。匹配是区分大小写的精确连续子串，只在同一 OCR 行内查找；不支持正则或
通配符。创建后的检索词不可修改。`parallel_workers` 若提供，只允许整数 `1`。

| 方法 | 说明 | 状态 |
| --- | --- | --- |
| `app.info` | 引擎版本 / 协议版本 / python 路径 | ✅ |
| `diagnostics.run` | 环境自检（Tesseract / DjVu / 语言包 / RapidOCR / onnx） | ✅ |
| `tasks.*` / `results.*` / `review.*` / `export.*` / `exports.list` / `files.*` / `settings.*` | 见 `MethodNameSchema` | ✅ |

### 任务与导出列表扩展

- `tasks.list` 接受 `limit`（1～100）、`offset`、可选 `status` 和可选 `query`；响应包含 `items`、`limit`、`offset` 与符合筛选条件的 `total`。`query` 在任务名称、来源目录、来源标签、文件清单展示名与检索词中做本地包含匹配。
- `tasks.get` 除任务摘要外返回最多 100 条结构化 `failures`，供任务页解释部分成功或失败原因。
- `tasks.delete` 仅接受已完成、失败或已取消的任务；调用方必须先取消其他状态的任务。删除会清理本地任务记录、扫描结果、校对/导出记录和应用生成的页面图片，不会删除任何来源文件。
- `exports.list` 按最近写入顺序返回指定任务的持久化导出记录；导出文件仍保存在该任务本地工作区。

### 本地显示设置

- `settings.get` 与 `settings.update` 是 Renderer 到 Electron Main 的本地 IPC，不经过 Python Sidecar。
- 校对高亮样式由 6 位十六进制 `color` 和 `0.1`～`0.6` 的 `opacity` 组成，保存在 `userData/settings.json`。
- `settings.update` 支持修改 `global` 全局默认，或按 `task_id` 保存/清除 `task` 覆盖；读取时返回全局值、任务覆盖和最终生效值。
- 删除任务时会清理对应的任务高亮覆盖，但不会影响全局设置或其他任务。

## 健壮性保证

- Main 端 `JsonLineReader` 处理粘包 / 半行；
- 无效 JSON 仅记录，不响应、不崩溃；
- 未知方法 → `UNKNOWN_METHOD`；
- 任意 handler 异常 → `UNKNOWN_ERROR`，server 不退出；
- 请求支持超时（默认 30s）；Sidecar 退出时所有 pending 请求失败为 `ENGINE_CRASHED`；
- Main 将 Sidecar 异常广播给 Renderer。

## Legacy 未完成任务

从缺少可信 processed pages/checkpoint 的旧 schema 迁移时，任务会进入 `recoverable` 并设置 `LEGACY_TASK_REQUIRES_REVIEW`。`tasks.resume` 对该错误码 fail-closed：不伪造 checkpoint、不重新扫描、不删除旧 occurrence/review/note/export。Renderer 显示只读说明，并允许把原来源目录带入新任务页面。
