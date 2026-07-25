/**
 * 异步请求身份守卫（P1-4/P1-1 共用）。
 *
 * 跨任务/跨路由的异步请求（listJobs、corpusStatus、search.execute 等）在切换
 * taskId 时必须作废旧请求，避免旧结果覆盖新页面。本模块把"请求身份是否仍匹配
 * 当前页面"的判定抽成纯函数，便于确定性单测（可控 Promise/deferred）。
 *
 * 请求身份 = (requestTaskId, requestGeneration, requestSequence)。
 * 页面身份 = (currentTaskId, currentGeneration, currentSequence, mounted)。
 * 只有四项全部匹配时才允许写入 state。
 */

export interface RequestIdentity {
  /** 发起请求时的路由 taskId。 */
  taskId: string;
  /** 发起请求时的 routeGeneration（taskId 变化时递增）。 */
  generation: number;
  /** 发起请求时的 requestSequence（每次请求递增）。 */
  sequence: number;
}

export interface PageContext {
  /** 当前路由 taskId。 */
  currentTaskId: string;
  /** 当前 routeGeneration。 */
  currentGeneration: number;
  /** 当前 requestSequence。 */
  currentSequence: number;
  /** 组件是否仍挂载。 */
  mounted: boolean;
}

/**
 * 判定一次异步请求的结果是否仍可安全写入当前页面 state。
 *
 * 任一守卫缺失即返回 false：
 * - 组件已卸载（mounted=false）→ 不写 state（避免 React 警告与内存泄漏）
 * - taskId 已变化 → 旧任务的请求不得写入新页面
 * - routeGeneration 已变化 → 路由切换使旧请求作废
 * - requestSequence 已变化 → 同一页面内更新的请求使旧请求作废
 */
export function shouldCommit(request: RequestIdentity, page: PageContext): boolean {
  if (!page.mounted) return false;
  if (request.taskId !== page.currentTaskId) return false;
  if (request.generation !== page.currentGeneration) return false;
  if (request.sequence !== page.currentSequence) return false;
  return true;
}

/**
 * 判定一个导出/检索作业是否属于当前路由任务（P1-4 stale cancel/retry 守卫）。
 * jobTaskId 必须严格等于 currentTaskId；undefined/null 视为不匹配（fail closed）。
 */
export function jobBelongsToTask(jobTaskId: string | undefined | null, currentTaskId: string | undefined | null): boolean {
  if (!jobTaskId || !currentTaskId) return false;
  return jobTaskId === currentTaskId;
}
