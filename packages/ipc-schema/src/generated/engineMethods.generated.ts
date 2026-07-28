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

export type EngineMethodName = typeof ENGINE_METHOD_NAMES[number];
export type EnginePublicMethodName = typeof ENGINE_PUBLIC_METHOD_NAMES[number];
export type EngineInternalMethodName = typeof ENGINE_INTERNAL_METHOD_NAMES[number];
export type EngineTestMethodName = typeof ENGINE_TEST_METHOD_NAMES[number];
export type EngineParamSchemaId = typeof ENGINE_PARAM_SCHEMA_IDS[number];
export type EngineResultSchemaId = typeof ENGINE_RESULT_SCHEMA_IDS[number];

export type EngineMethodVisibility =
  | "engine_public"
  | "engine_internal"
  | "engine_test";
