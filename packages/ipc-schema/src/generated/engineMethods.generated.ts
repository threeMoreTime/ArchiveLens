// AUTO-GENERATED from contracts/engine-methods.json — DO NOT EDIT.
// 由 scripts/generate-ipc-contract.mjs 生成。修改请编辑契约 JSON 后重新生成。

/** 全部 Engine 方法名（字典序）（42 项）。 */
export const ENGINE_METHOD_NAMES = [
  "app.info",
  "app.shutdown",
  "demo.create",
  "diagnostics.run",
  "export.html",
  "export.json",
  "export.review",
  "exports.cancel",
  "exports.create",
  "exports.get",
  "exports.list",
  "exports.listJobs",
  "exports.retry",
  "results.getDetail",
  "results.query",
  "review.layoutContext",
  "review.preparePageImage",
  "review.previewLayoutContext",
  "review.rebuildLayoutContexts",
  "review.updateDecision",
  "review.updateDecisions",
  "review.updateLayoutOverride",
  "review.updateNote",
  "search.corpusStatus",
  "search.execute",
  "search.hits",
  "search.preparePageImage",
  "search.sessions",
  "storage.cleanupTemporary",
  "tasks.cancel",
  "tasks.cleanupTarget",
  "tasks.create",
  "tasks.delete",
  "tasks.get",
  "tasks.inspectState",
  "tasks.list",
  "tasks.pause",
  "tasks.preflight",
  "tasks.preflightCancel",
  "tasks.preflightGet",
  "tasks.resume",
  "tasks.start",
] as const;

/** 生产可调用的 Engine 方法（38 项）。 */
export const ENGINE_PUBLIC_METHOD_NAMES = [
  "demo.create",
  "export.html",
  "export.json",
  "export.review",
  "exports.cancel",
  "exports.create",
  "exports.get",
  "exports.list",
  "exports.listJobs",
  "exports.retry",
  "results.getDetail",
  "results.query",
  "review.layoutContext",
  "review.preparePageImage",
  "review.previewLayoutContext",
  "review.rebuildLayoutContexts",
  "review.updateDecision",
  "review.updateDecisions",
  "review.updateLayoutOverride",
  "review.updateNote",
  "search.corpusStatus",
  "search.execute",
  "search.hits",
  "search.preparePageImage",
  "search.sessions",
  "storage.cleanupTemporary",
  "tasks.cancel",
  "tasks.cleanupTarget",
  "tasks.create",
  "tasks.delete",
  "tasks.get",
  "tasks.list",
  "tasks.pause",
  "tasks.preflight",
  "tasks.preflightCancel",
  "tasks.preflightGet",
  "tasks.resume",
  "tasks.start",
] as const;

/** Engine 生命周期/进程/诊断方法（仅 Main 受控调用）（3 项）。 */
export const ENGINE_INTERNAL_METHOD_NAMES = [
  "app.info",
  "app.shutdown",
  "diagnostics.run",
] as const;

/** 仅 E2E 测试使用的 Engine 方法（1 项）。 */
export const ENGINE_TEST_METHOD_NAMES = [
  "tasks.inspectState",
] as const;

/** 参数 schema 语义 ID（params.kind=schema 引用）（14 项）。 */
export const ENGINE_PARAM_SCHEMA_IDS = [
  "OcrSearchExecuteParams",
  "OcrSearchHitsParams",
  "OcrSearchPreparePageImageParams",
  "OcrSearchSessionsParams",
  "ReviewLayoutContextParams",
  "ReviewPreviewLayoutContextParams",
  "ReviewRebuildLayoutContextsParams",
  "ReviewUpdateDecisionParams",
  "ReviewUpdateDecisionsParams",
  "ReviewUpdateLayoutOverrideParams",
  "SourcePreflightJobParams",
  "SourcePreflightStartParams",
  "TaskCreateParams",
  "TaskIdOnlyParams",
] as const;

/** 结果 schema 语义 ID（result.kind=schema 引用）（34 项）。 */
export const ENGINE_RESULT_SCHEMA_IDS = [
  "AppInfoResult",
  "AppShutdownResult",
  "DemoCreateResult",
  "DiagnosticsResult",
  "ExportHtmlResult",
  "ExportJob",
  "ExportJobActionResult",
  "ExportJobCreateResult",
  "ExportJobsListResult",
  "ExportJsonResult",
  "ExportReviewResult",
  "ExportsListResult",
  "LayoutRebuildProgress",
  "OccurrenceDetail",
  "OcrCorpusStatusResult",
  "OcrSearchHitsResult",
  "OcrSearchSession",
  "OcrSearchSessionsResult",
  "ResultsQueryResult",
  "ReviewLayoutContextResult",
  "ReviewPageImageResult",
  "ReviewUpdateDecisionResult",
  "ReviewUpdateDecisionsResult",
  "ReviewUpdateLayoutOverrideResult",
  "ReviewUpdateNoteResult",
  "SourcePreflightJob",
  "StorageCleanupResult",
  "TaskActionResult",
  "TaskCleanupTargetResult",
  "TaskCreateResult",
  "TaskDeleteResult",
  "TaskInspectStateResult",
  "TaskSummary",
  "TasksListResult",
] as const;

/** 每个 Engine 方法的结果契约（由 engine-methods.json result 字段派生）。 */
export const ENGINE_METHOD_RESULT_CONTRACT = {
  "app.info": { kind: "schema", schemaId: "AppInfoResult" },
  "app.shutdown": { kind: "schema", schemaId: "AppShutdownResult" },
  "demo.create": { kind: "schema", schemaId: "DemoCreateResult" },
  "diagnostics.run": { kind: "schema", schemaId: "DiagnosticsResult" },
  "export.html": { kind: "schema", schemaId: "ExportHtmlResult" },
  "export.json": { kind: "schema", schemaId: "ExportJsonResult" },
  "export.review": { kind: "schema", schemaId: "ExportReviewResult" },
  "exports.cancel": { kind: "schema", schemaId: "ExportJobActionResult" },
  "exports.create": { kind: "schema", schemaId: "ExportJobCreateResult" },
  "exports.get": { kind: "schema", schemaId: "ExportJob" },
  "exports.list": { kind: "schema", schemaId: "ExportsListResult" },
  "exports.listJobs": { kind: "schema", schemaId: "ExportJobsListResult" },
  "exports.retry": { kind: "schema", schemaId: "ExportJobCreateResult" },
  "results.getDetail": { kind: "schema", schemaId: "OccurrenceDetail" },
  "results.query": { kind: "schema", schemaId: "ResultsQueryResult" },
  "review.layoutContext": { kind: "schema", schemaId: "ReviewLayoutContextResult" },
  "review.preparePageImage": { kind: "schema", schemaId: "ReviewPageImageResult" },
  "review.previewLayoutContext": { kind: "schema", schemaId: "ReviewLayoutContextResult" },
  "review.rebuildLayoutContexts": { kind: "schema", schemaId: "LayoutRebuildProgress" },
  "review.updateDecision": { kind: "schema", schemaId: "ReviewUpdateDecisionResult" },
  "review.updateDecisions": { kind: "schema", schemaId: "ReviewUpdateDecisionsResult" },
  "review.updateLayoutOverride": { kind: "schema", schemaId: "ReviewUpdateLayoutOverrideResult" },
  "review.updateNote": { kind: "schema", schemaId: "ReviewUpdateNoteResult" },
  "search.corpusStatus": { kind: "schema", schemaId: "OcrCorpusStatusResult" },
  "search.execute": { kind: "schema", schemaId: "OcrSearchSession" },
  "search.hits": { kind: "schema", schemaId: "OcrSearchHitsResult" },
  "search.preparePageImage": { kind: "schema", schemaId: "ReviewPageImageResult" },
  "search.sessions": { kind: "schema", schemaId: "OcrSearchSessionsResult" },
  "storage.cleanupTemporary": { kind: "schema", schemaId: "StorageCleanupResult" },
  "tasks.cancel": { kind: "schema", schemaId: "TaskActionResult" },
  "tasks.cleanupTarget": { kind: "schema", schemaId: "TaskCleanupTargetResult" },
  "tasks.create": { kind: "schema", schemaId: "TaskCreateResult" },
  "tasks.delete": { kind: "schema", schemaId: "TaskDeleteResult" },
  "tasks.get": { kind: "schema", schemaId: "TaskSummary" },
  "tasks.inspectState": { kind: "schema", schemaId: "TaskInspectStateResult" },
  "tasks.list": { kind: "schema", schemaId: "TasksListResult" },
  "tasks.pause": { kind: "schema", schemaId: "TaskActionResult" },
  "tasks.preflight": { kind: "schema", schemaId: "SourcePreflightJob" },
  "tasks.preflightCancel": { kind: "schema", schemaId: "SourcePreflightJob" },
  "tasks.preflightGet": { kind: "schema", schemaId: "SourcePreflightJob" },
  "tasks.resume": { kind: "schema", schemaId: "TaskActionResult" },
  "tasks.start": { kind: "schema", schemaId: "TaskActionResult" },
} as const satisfies Record<EngineMethodName, EngineMethodResultEntry>;

export type EngineMethodName = typeof ENGINE_METHOD_NAMES[number];
export type EnginePublicMethodName = typeof ENGINE_PUBLIC_METHOD_NAMES[number];
export type EngineInternalMethodName = typeof ENGINE_INTERNAL_METHOD_NAMES[number];
export type EngineTestMethodName = typeof ENGINE_TEST_METHOD_NAMES[number];
export type EngineParamSchemaId = typeof ENGINE_PARAM_SCHEMA_IDS[number];
export type EngineResultSchemaId = typeof ENGINE_RESULT_SCHEMA_IDS[number];

export type EngineMethodResultEntry =
  | { readonly kind: "schema"; readonly schemaId: EngineResultSchemaId }
  | { readonly kind: "empty_object" };
export type EngineMethodVisibility =
  | "engine_public"
  | "engine_internal"
  | "engine_test";
