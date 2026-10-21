/**
 * The chunk side of the Postgres keyword statement (PostgresEngine.searchKeyword):
 * where `cc` comes from, the full-text match, and the text-modality filter.
 *
 * excludePrivate (remote callers) adds correlated visibility subplans that
 * inflate the cost of every join plan, so a cheaper bitmap scan on the match
 * fell within the planner's 1% fuzz of a serial seq scan and lost on startup
 * cost; that seq scan detoasts every chunk's search_vector (~1.1 s for a
 * common term at 250k chunks). The OFFSET 0 subquery plans the match on its
 * own. Without those subplans the join plans well, often in parallel, which
 * an OFFSET subquery would forbid, so it stays unfenced.
 *
 * `modality = 'text'` (v0.27.1) hides image rows from text-keyword search so
 * OCR text doesn't drown text-page hits; image search runs a separate vector
 * path on embedding_image.
 *
 * `ftsLang` must already be validated (getFtsLanguage); `$1` is the websearch text.
 */
/**
 * Most matching chunks the Postgres keyword statement ranks (GBRA-156).
 * ts_rank runs on every row it is given, so a query whose terms match
 * hundreds of thousands of chunks (one common word on a 2M-chunk brain)
 * spent 3-8 s ranking and ran into the keyword statement timeout, which
 * returns no rows at all. The statement takes the first matching chunks
 * that pass its filters, up to this bound, and ranks those; a match set under
 * the bound ranks exactly as before. When the bound applies the caller is
 * told (SearchOpts.onKeywordIncomplete), and hybrid reports
 * `keyword_candidates_incomplete`, because the rows come from a sample.
 */
export const KEYWORD_RANK_CANDIDATES = 50_000;

/**
 * Transaction-local settings for the keyword statement. At the 4 MB
 * `work_mem` default, the bitmap over a common word's matches goes lossy, so
 * the heap scan rechecks every row's tsvector, and the bounded candidate sort
 * spills to disk: a remote caller's bounded any-word retry took 6.6 s on the
 * 2M-chunk bench against 1.4 s at 32 MB (128 MB measured the same). The
 * bound keeps the memory this can use per statement small.
 */
export const KEYWORD_STATEMENT_SETTINGS = { work_mem: '32MB' } as const;

export function buildKeywordChunkMatch(
  ftsLang: string,
  excludePrivate: boolean | undefined,
  // Local fork patch (CJK bigram FTS): CJK queries tokenize through
  // gbrain_cjk_search_tokens; the caller passes the fully-built tsquery
  // expression so the excludePrivate subquery matches the outer rank expr.
  tsquery: string = `websearch_to_tsquery('${ftsLang}', $1)`,
): { from: string; match: string; modality: string } {
  const tsq = tsquery;
  if (!excludePrivate) return { from: 'content_chunks cc', match: `cc.search_vector @@ ${tsq}`, modality: `AND cc.modality = 'text'` };
  return {
    // chunk-visibility-ok: the outer search statement applies buildVisibilityClause(..., { chunkAlias: 'cc' }) to the generation columns this subquery projects
    from: `(
          SELECT id, page_id, chunk_index, chunk_text, chunk_source, search_vector, language, symbol_type, body_generation, occurrence_id
          FROM content_chunks
          WHERE search_vector @@ ${tsq} AND modality = 'text'
          OFFSET 0
        ) cc`,
    match: 'true',
    modality: '',
  };
}
