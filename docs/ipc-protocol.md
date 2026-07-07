# IPC 协议

Electron Main ↔ Python Engine 之间的通信协议：**UTF-8 JSON Lines over stdin/stdout**。

- 每条消息一行，完整 JSON 对象；
- `stdout` **只**输出协议消息；普通日志走 `stderr` / 日志文件；
- `protocol_version` 当前为 `1`，TS（`packages/ipc-schema/src/index.ts`，Zod）与 Python（`archivelens_engine/protocol.py`）**必须一致**；
- 不兼容版本必须显式失败（`PROTOCOL_MISMATCH`），不得静默继续。

## 请求

```json
{ "protocol_version": 1, "request_id": "<uuid>", "method": "app.info", "params": {} }
```

## 成功响应

```json
{ "protocol_version": 1, "request_id": "<uuid>", "ok": true, "result": {} }
```

## 错误响应

```json
{ "protocol_version": 1, "request_id": "<uuid>", "ok": false,
  "error": { "code": "DEPENDENCY_MISSING", "message": "缺少繁体中文 OCR 语言包", "details": {} } }
```

`request_id` 在错误响应中允许为 `null`（如无效 JSON 场景）。Main 侧对 `null` 仅记录、不关联 pending。

## 事件（Server → Main 单向）

```json
{ "protocol_version": 1, "event": "task.progress", "task_id": "<uuid>",
  "payload": { "processed_pages": 125, "total_pages": 500 } }
```

启动事件 `engine.ready` 握手：

```json
{ "protocol_version": 1, "event": "engine.ready", "task_id": null,
  "payload": { "engine_version": "0.1.0", "protocol_version": 1 } }
```

## 错误码

`VALIDATION_ERROR` · `PATH_NOT_FOUND` · `PERMISSION_DENIED` · `DEPENDENCY_MISSING` · `ENGINE_START_FAILED` · `ENGINE_CRASHED` · `IPC_TIMEOUT` · `TASK_NOT_FOUND` · `TASK_STATE_CONFLICT` · `DATABASE_ERROR` · `EXPORT_FAILED` · `DISK_SPACE_LOW` · `UNSUPPORTED_FILE` · `PROTOCOL_MISMATCH` · `UNKNOWN_METHOD` · `UNKNOWN_ERROR`

## 已实现方法

| 方法 | 说明 | 状态 |
| --- | --- | --- |
| `app.info` | 引擎版本 / 协议版本 / python 路径 | ✅ |
| `diagnostics.run` | 环境自检（Tesseract / DjVu / 语言包 / RapidOCR / onnx） | ✅ |
| `tasks.*` / `results.*` / `review.*` / `export.*` / `files.*` / `settings.*` | 见 `MethodNameSchema` | ⏳ 进行中 |

## 健壮性保证

- Main 端 `JsonLineReader` 处理粘包 / 半行；
- 无效 JSON 仅记录，不响应、不崩溃；
- 未知方法 → `UNKNOWN_METHOD`；
- 任意 handler 异常 → `UNKNOWN_ERROR`，server 不退出；
- 请求支持超时（默认 30s）；Sidecar 退出时所有 pending 请求失败为 `ENGINE_CRASHED`；
- Main 将 Sidecar 异常广播给 Renderer。
