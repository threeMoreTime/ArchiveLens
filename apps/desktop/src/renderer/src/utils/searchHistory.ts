import type { OcrSearchSession, SearchScriptScope } from "@shared/index";

type SearchIdentity = Pick<OcrSearchSession, "normalized_query" | "script_scope">;

/** Keep renderer-side identity exactly aligned with the engine's literal-search normalization. */
export function normalizeSearchQueryText(query: string): string {
  return query.normalize("NFC").replace(/^ +| +$/g, "");
}

export function searchHistoryKey(search: SearchIdentity): string {
  return `${search.script_scope}\u0000${search.normalized_query}`;
}

/**
 * 检索会话仍由引擎完整保留，这里只把相同词语和字形范围折叠为最新一组，
 * 避免历史栏被重复操作淹没。
 */
export function dedupeSearchSessions(sessions: readonly OcrSearchSession[]): OcrSearchSession[] {
  const seen = new Set<string>();
  const result: OcrSearchSession[] = [];
  for (const session of sessions) {
    const key = searchHistoryKey(session);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(session);
  }
  return result;
}

export function prependSearchSession(
  sessions: readonly OcrSearchSession[],
  session: OcrSearchSession,
): OcrSearchSession[] {
  return dedupeSearchSessions([session, ...sessions]);
}

export function findReusableSearchSession(
  sessions: readonly OcrSearchSession[],
  queryText: string,
  scriptScope: SearchScriptScope,
  corpusVersion: number,
): OcrSearchSession | null {
  const key = searchHistoryKey({
    normalized_query: normalizeSearchQueryText(queryText),
    script_scope: scriptScope,
  });
  return sessions.find((session) => (
    session.corpus_version === corpusVersion && searchHistoryKey(session) === key
  )) ?? null;
}
