import { describe, expect, it } from "vitest";
import type { OcrSearchSession, SearchScriptScope } from "@shared/index";
import {
  dedupeSearchSessions,
  findReusableSearchSession,
  normalizeSearchQueryText,
  prependSearchSession,
} from "../src/renderer/src/utils/searchHistory";

function searchSession(
  id: string,
  queryText: string,
  scriptScope: SearchScriptScope = "both",
  corpusVersion = 3,
): OcrSearchSession {
  return {
    search_session_id: id,
    task_id: "task-1",
    query_text: queryText,
    normalized_query: normalizeSearchQueryText(queryText),
    script_scope: scriptScope,
    status: "completed",
    corpus_version: corpusVersion,
    query_forms: {
      forms: {
        original: queryText,
        simplified: queryText,
        traditional: queryText,
        taiwan: queryText,
        hong_kong: queryText,
      },
      semantic_status: "glyph_only_unconfirmed",
      semantic_label: "字形关联",
      opencc_phrase_evidence: {},
      single_character_variants: [],
    },
    counts: {
      total: 1,
      layers: {},
      scripts: {},
      verification: {},
      candidate_pending_review: 0,
      corpus_status: "ready",
      corpus_incomplete: false,
    },
    created_at: "2026-07-20T00:00:00Z",
    completed_at: "2026-07-20T00:00:01Z",
  };
}

describe("search history presentation", () => {
  it("keeps the newest session for an equivalent query and script scope", () => {
    const newest = searchSession("new", "  Cafe\u0301  ");
    const old = searchSession("old", "Café");
    const traditional = searchSession("traditional", "Café", "traditional");

    expect(dedupeSearchSessions([newest, old, traditional]).map((item) => item.search_session_id))
      .toEqual(["new", "traditional"]);
  });

  it("keeps literal queries distinct when case, width or whitespace differs", () => {
    const sessions = [
      searchSession("upper", "A"),
      searchSession("lower", "a"),
      searchSession("wide", "Ａ"),
      searchSession("ascii-space", "本館 清冊"),
      searchSession("ideographic-space", "本館　清冊"),
    ];

    expect(dedupeSearchSessions(sessions).map((item) => item.search_session_id)).toEqual([
      "upper",
      "lower",
      "wide",
      "ascii-space",
      "ideographic-space",
    ]);
    expect(findReusableSearchSession(sessions, " a ", "both", 3)?.search_session_id).toBe("lower");
    expect(findReusableSearchSession(sessions, "Ａ", "both", 3)?.search_session_id).toBe("wide");
    expect(findReusableSearchSession(sessions, "本館　清冊", "both", 3)?.search_session_id).toBe("ideographic-space");
  });

  it("prepends a rerun while removing the superseded visible group", () => {
    const old = searchSession("old", "档案");
    const next = searchSession("next", "档案");

    expect(prependSearchSession([old], next).map((item) => item.search_session_id)).toEqual(["next"]);
  });

  it("reuses an exact visible group only for the current corpus version", () => {
    const current = searchSession("current", "档案", "both", 4);
    const stale = searchSession("stale", "清册", "both", 3);

    expect(findReusableSearchSession([current, stale], " 档案 ", "both", 4)?.search_session_id).toBe("current");
    expect(findReusableSearchSession([current, stale], "档案", "simplified", 4)).toBeNull();
    expect(findReusableSearchSession([current, stale], "清册", "both", 4)).toBeNull();
  });
});
