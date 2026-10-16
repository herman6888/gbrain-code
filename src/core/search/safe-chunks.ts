import type { ChunkInput, PageReadScope } from '../types.ts';
import { jsonRowBatches } from '../batch-rows.ts';

/** First markdown index built from the strict full-body fence sanitizer. */
export const SAFE_FENCE_CHUNKER_VERSION = 4;

const PROTECTED_MARKER = '<!--- gbrain:(facts|takes):(begin|end) -->';

export function hasProtectedBody(text: string): boolean {
  return new RegExp(PROTECTED_MARKER).test(text);
}

/** Expression and aliases are internal SQL, never caller-supplied values. */
export function protectedTextFilter(expression: string): string {
  return `COALESCE(${expression}, '') ~ '${PROTECTED_MARKER}'`;
}

/**
 * Fixed SQL aliases only. Check full bodies because fragments can lose markers.
 * A segmented page has no body columns: its `body_flags.has_protected` (set by
 * the ingest from the segmenter's regions) decides, and a page without the
 * flag counts as protected (fail closed).
 */
export function protectedBodyFilter(alias: string): string {
  return `(CASE WHEN ${alias}.body_storage = 'segmented' THEN ${alias}.body_flags->>'has_protected' IS DISTINCT FROM 'false'
    ELSE (${protectedTextFilter(`${alias}.compiled_truth`)} OR ${protectedTextFilter(`${alias}.timeline`)}) END)`;
}

/** A body-only write cannot certify old fragments, even after fence removal. */
export function bodyWriteChunkVersion(compiledTruth: string, timeline: string): string {
  return `CASE WHEN pages.compiled_truth IS NOT DISTINCT FROM ${compiledTruth}
    AND pages.timeline IS NOT DISTINCT FROM ${timeline} THEN pages.chunker_version
    WHEN pages.chunker_version < 0 OR ${protectedBodyFilter('pages')}
      OR ${protectedTextFilter(compiledTruth)} OR ${protectedTextFilter(timeline)} THEN -1
    ELSE LEAST(COALESCE(pages.chunker_version, 0), ${SAFE_FENCE_CHUNKER_VERSION - 1}) END`;
}

export function requiresSafeChunks(scope?: PageReadScope): boolean {
  return scope?.requireSafeChunks ?? scope?.excludePrivate ?? false;
}

/** Every user sees projections only from the current canonical revision. */
export function currentTextProjectionFilter(alias: string): string {
  return `(${alias}.text_projection_revision = ${alias}.knowledge_revision) IS TRUE`;
}

/**
 * Wave B: the chunk row belongs to its page's live body generation. Staged rows
 * (`body_generation` above the page's) and retired rows are invisible; every
 * inline-page row (`body_generation IS NULL`) passes. Row predicate, no join.
 */
export function chunkGenerationFilter(page: string, chunk: string): string {
  return `(${chunk}.body_generation IS NULL
       OR (${chunk}.body_generation <= ${page}.body_generation
           AND (${chunk}.retired_generation IS NULL OR ${chunk}.retired_generation > ${page}.body_generation)))`;
}

/** `chunkGenerationFilter` for a statement that has no page row joined: inline rows pass without the page lookup. */
export function chunkGenerationProbe(chunk: string): string {
  return `(${chunk}.body_generation IS NULL
       OR EXISTS (SELECT 1 FROM pages gp WHERE gp.id = ${chunk}.page_id AND ${chunkGenerationFilter('gp', chunk)}))`;
}

/** Search-facing chunk visibility: the current text projection and the live body generation. */
export function chunkVisibleFilter(page: string, chunk: string): string {
  return `(${currentTextProjectionFilter(page)} AND ${chunkGenerationFilter(page, chunk)})`;
}

/**
 * The live manifest row of a segmented chunk (no row for an inline chunk), for
 * `chunkDocumentOrder`. LEFT JOIN text; `page` must expose `body_generation`.
 */
export function chunkManifestJoin(page: string, chunk: string, manifest: string): string {
  return `LEFT JOIN page_body_manifest ${manifest} ON ${chunk}.occurrence_id IS NOT NULL
       AND ${manifest}.page_id = ${chunk}.page_id AND ${manifest}.occurrence_id = ${chunk}.occurrence_id
       AND ${manifest}.staging_id IS NULL AND ${manifest}.gen_from <= ${page}.body_generation
       AND (${manifest}.gen_to IS NULL OR ${manifest}.gen_to > ${page}.body_generation)`;
}

/** Document order: (manifest byte_start, local_ordinal) for segmented rows; inline rows keep chunk_index order. */
export function chunkDocumentOrder(chunk: string, manifest: string): string {
  return `${manifest}.byte_start, ${chunk}.local_ordinal, ${chunk}.chunk_index`;
}

/** A page of any kind chunked before the fence; remote reads withhold it until it is re-sealed. */
export function belowSafeChunkFence(chunkerVersion: number | null | undefined): boolean {
  return (chunkerVersion ?? 0) < SAFE_FENCE_CHUNKER_VERSION;
}

/**
 * Older fragments lack trustworthy provenance, even if markers were removed
 * later. `pages.chunker_version` is `smallint NOT NULL` at head on both
 * engines (v054), so the bare column compares and keeps its statistics (#6632:
 * a COALESCE gets the default 1/3 selectivity and misleads the count plan).
 */
export function safeChunksFilter(alias: string): string {
  return `${alias}.chunker_version >= ${SAFE_FENCE_CHUNKER_VERSION}`;
}

/**
 * Preserve an existing seal for an embedding-only refresh of the exact chunk
 * snapshot. Additions, removals and textual metadata changes invalidate before
 * the first mutation, including partial failures outside an import transaction.
 * Both engines canonicalize chunk_text before calling, and persist/hash those
 * same bytes. Identity and enum fields retain their existing rejection policy.
 *
 * One statement per encoded batch of the incoming set (`jsonRowBatches`), so a
 * large page is compared without one whole-page JSON document; each statement
 * also checks for stored chunks missing from the complete incoming index set.
 * The caller stops at the first statement that invalidates (RETURNING id).
 */
export function* chunkWriteInvalidations(pageId: number, chunks: ChunkInput[]): Generator<{ sql: string; params: unknown[] }> {
  const metadata = ['language', 'symbol_name', 'symbol_type', 'start_line', 'end_line', 'parent_symbol_path', 'doc_comment', 'symbol_name_qualified'] as const;
  // chunk-visibility-ok: inline chunk write invalidation; segmented pages stage rows through stageSegmentChunks
  const sql = `UPDATE pages SET chunker_version = -1 WHERE id = $1 AND (
      NOT (${safeChunksFilter('pages')})
      OR EXISTS (SELECT 1 FROM content_chunks cc WHERE cc.page_id = $1 AND cc.chunk_index <> ALL($3::int[]))
      OR EXISTS (
        SELECT 1 FROM jsonb_to_recordset($2::text::jsonb) AS incoming(
          chunk_index int, chunk_text text, chunk_source text, modality text,
          language text, symbol_name text, symbol_type text, start_line int,
          end_line int, parent_symbol_path text[], doc_comment text, symbol_name_qualified text)
        LEFT JOIN content_chunks cc ON cc.page_id = $1 AND cc.chunk_index = incoming.chunk_index
        WHERE cc.id IS NULL
          OR cc.chunk_text IS DISTINCT FROM incoming.chunk_text
          OR cc.chunk_source IS DISTINCT FROM incoming.chunk_source
          OR cc.modality IS DISTINCT FROM COALESCE(incoming.modality, 'text')
          ${metadata.map(key => `OR cc.${key} IS DISTINCT FROM COALESCE(incoming.${key}, cc.${key})`).join('\n          ')}
      )) RETURNING id`;
  const indices = chunks.map(chunk => chunk.chunk_index);
  const batches = jsonRowBatches(chunks, chunk => Object.fromEntries(
    ['chunk_index', 'chunk_text', 'chunk_source', 'modality', ...metadata].map(key => [key, chunk[key as keyof ChunkInput] ?? null])));
  let sent = false;
  for (const batch of batches) {
    sent = true;
    yield { sql, params: [pageId, batch, indices] };
  }
  if (!sent) yield { sql, params: [pageId, '[]', indices] };
}

/**
 * A stored row whose vector provably describes its own text (#4246), the only
 * rows a content-keyed rebuild moves to a new index. `col` is a quoted column.
 */
export function movableChunkSql(col: string): string {
  return `(${col} IS NOT NULL AND embedded_text_hash IS NOT DISTINCT FROM md5(chunk_text))`;
}
