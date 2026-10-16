/**
 * Segmented page ingest (Wave B, spec 3.1-3.3): turns a page body (the stored
 * stream of its truth region, then its timeline region) into staged segment
 * texts, a diff against the live manifest and staged manifest and chunk rows,
 * all outside the publication transaction. Memory is O(segment): the regions
 * arrive as byte streams, texts are flushed in STAGE_BATCH_BYTES statements and
 * chunking reads the staged texts back one batch at a time.
 *
 * Diff (spec 3.3 step 3): a new segment whose `(sha256, entry_state)` matches a
 * live occurrence keeps that occurrence id; it keeps its row too when every
 * coordinate (seq, offsets, hash midstate) is unchanged, else it gets a new
 * row with the same id (shifted). Other segments get fresh ids. Live
 * occurrences left unmatched retire. `content_hash` resumes from the hash
 * midstate of the last row of the unchanged prefix (1.4).
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { stableJson } from '../persistence/digest.ts';
import { faultPoint } from '../persistence/fault-points.ts';
import { withCoordinatedWrite } from '../persistence/context.ts';
import { readManagedMode } from '../persistence/managed-mode.ts';
import { maintenanceAttribution, principalAttribution } from '../persistence/attribution.ts';
import type { Principal } from '../persistence/model.ts';
import { stepFenceWalk, type FenceWalk } from '../fence-scan.ts';
import { BODY_LEAD_BYTES, BODY_STAGING_HARD_MS, BODY_STAGING_IDLE_MS, STAGE_BATCH_BYTES } from './limits.ts';
import type { BodyRegion, BodyStagingKind, BodyStorage, JsonObject, ManifestRow, ManifestRowInput, SegmentChunkInput,
  SegmentedBodyColumns, SegmentTextInput } from './types.ts';
import { segmentProjectionParts, segmentStream, SEGMENTER_VERSION, type StoredRegion } from './segmenter.ts';
import { initialEntryState, readEntryState, timelineEntryState, type EntryState } from './entry-state.ts';
import { ContentHashStream } from './content-hash-stream.ts';
import { prepareSegmentChunks } from './segment-chunks.ts';
import { reuseSegmentChunkVectors } from '../import-chunk-reuse.ts';
import { newFenceChunkBudget } from '../markdown-chunks.ts';
import { loadFenceChunkOverlay } from '../eligibility/fence-overlay.ts';

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** The live page a segmented write replaces (null: create). */
export interface SegmentedLivePage { id: number; generation: number; storage: BodyStorage; title: string; type: string; flags: JsonObject | null }

/** Who stages, for the `page_body_stagings` row (a GC root while open). */
export interface SegmentedStagingOwner { kind: BodyStagingKind; principalKind: string; principalId: string; baseRevision: string | null }

export interface SegmentedBodyInput {
  sourceId: string;
  slug: string;
  live: SegmentedLivePage | null;
  title: string;
  type: string;
  frontmatter: JsonObject;
  tags: readonly string[];
  /** The stored stream of each region (sanitized, valid UTF-8). */
  truth: AsyncIterable<Uint8Array>;
  timeline: AsyncIterable<Uint8Array>;
  /** The timeline region is not empty (the truth then ends at `region_end`, not `eof`). */
  hasTimeline: boolean;
  /** Page-global facts known at EOF (pass 1): `fence_trust`, `timeline_split`, ... */
  flags: JsonObject;
  /** Body bytes as declared by the source (exact for strings, the file size for streams). */
  declaredBytes: number;
  owner: SegmentedStagingOwner;
  /** Chunking inputs for a replace (a create chunks after publication). */
  chunking: SegmentChunkingContext;
}

export interface SegmentChunkingContext {
  /** Quarantined pages keep no chunks, as inline pages. */
  quarantined: boolean;
  corpusGeneration: string | null;
  tier: 'title' | 'none';
}

export interface PreparedSegmentedBody {
  stagingId: string;
  /** The live body generation the diff read (0 for create). */
  expectedGeneration: number;
  newGeneration: number;
  /** Create only: every manifest row, written in the publication transaction once the page row exists. */
  createRows: ManifestRowInput[] | null;
  closeOccurrences: number[];
  retireChunkOccurrences: number[];
  /** Occurrences of the new generation that have no chunk rows after staging (create: all; chunked after publication). */
  unchunked: number;
  body: SegmentedBodyColumns;
  /** No manifest row changed: the write changes metadata only. */
  bodyUnchanged: boolean;
  rows: { texts: number; manifest: number; chunks: number };
  /** `chunk_index` of every chunk row this preparation staged; the flip drops any other row staged under `newGeneration` (a dead preparation's). */
  stagedChunkIndexes: number[];
}

/**
 * Runs writes to the guarded segment tables (texts, manifest rows, sweeps) of
 * `sourceId` outside a publication transaction. On a managed brain they run in
 * a coordinated write for that source, as the writer guard requires
 * (writer-guard-schema.ts); the caller is the source's owner preparing or
 * collecting its own write (`principal`, else the local maintenance writer).
 * On any other brain they run directly.
 */
export async function segmentWriteScope(engine: BrainEngine, sourceId: string, principal?: Principal):
  Promise<<T>(fn: (exec: BrainEngine) => Promise<T>) => Promise<T>> {
  if (!await readManagedMode(engine)) return fn => fn(engine);
  const attribution = principal ? principalAttribution(principal) : await maintenanceAttribution(engine);
  return fn => engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => fn(tx), attribution));
}

/** A region of a string as a byte stream, sliced on code-point boundaries. */
export async function* stringRegion(text: string, sliceChars = 256 * 1024): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  for (let at = 0; at < text.length;) {
    let end = Math.min(text.length, at + sliceChars);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    yield encoder.encode(text.slice(at, end));
    at = end;
  }
}

/** The longest UTF-8 prefix of `bytes` within `max` bytes that ends on a code-point boundary, decoded. */
export function utf8Prefix(bytes: Uint8Array, max: number): string {
  let end = Math.min(bytes.length, max);
  if (end < bytes.length) while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return utf8.decode(bytes.subarray(0, end));
}

/** scanMarkdownCode's trust of a stored region: 'void' when a fence is left open or a longer opener sits inside one. */
export function regionFenceTrust(text: string): 'trusted' | 'void' {
  const walk: FenceWalk = { opener: null, mispaired: false };
  for (let at = 0; at <= text.length;) {
    let end = text.indexOf('\n', at);
    if (end < 0) end = text.length;
    for (const line of text.slice(at, end).split('\r')) stepFenceWalk(walk, line);
    at = end + 1;
  }
  return walk.opener || walk.mispaired ? 'void' : 'trusted';
}

/** `body_flags` of a page whose stored regions are strings (pass 1's fence trust, for the in-memory path). */
export function stringBodyFlags(truth: string, timeline: string): JsonObject {
  return { fence_trust: regionFenceTrust(truth), timeline_fence_trust: regionFenceTrust(timeline) };
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
/** The whole-region fence trust a region's stored regions are computed under (body_flags). */
export function regionTrust(flags: JsonObject | null | undefined, region: BodyRegion): 'trusted' | 'void' {
  return (region === 'truth' ? flags?.fence_trust : flags?.timeline_fence_trust) === 'void' ? 'void' : 'trusted';
}

/** An occurrence is its bytes, entry state and the trust its stored regions were computed under: a trust flip rechunks the region. */
const occurrenceKey = (sha256: Uint8Array, entryState: unknown, trust: 'trusted' | 'void') => `${hex(sha256)}|${stableJson(entryState)}|${trust}`;

/** Every coordinate of a live row equals the row the new segment would get, so the row stays. */
function rowUnchanged(live: ManifestRow, next: ManifestRowInput): boolean {
  return live.seq === next.seq && live.region === next.region && Number(live.byteStart) === next.byteStart
    && live.byteLen === next.byteLen && Number(live.lineStart) === next.lineStart && live.cutKind === next.cutKind
    && sameBytes(live.hashState, next.hashState) && stableJson(live.protectedRegions) === stableJson(next.protectedRegions)
    && stableJson(live.factsSlots) === stableJson(next.factsSlots) && stableJson(live.outline) === stableJson(next.outline)
    && live.staticProjBytes === next.staticProjBytes && live.staticProjLines === next.staticProjLines
    && live.dateMin === next.dateMin && live.dateMax === next.dateMax;
}

async function sourceIncarnation(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string): Promise<string> {
  const [row] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]);
  if (!row) throw new Error(`Source ${sourceId} not found.`);
  return row.incarnation;
}

/** Open the staging row every segmented write records (kind, principal, base); returns its id. */
export async function openSegmentedStaging(engine: BrainEngine, input: Pick<SegmentedBodyInput, 'sourceId' | 'slug' | 'live' | 'declaredBytes' | 'owner'>): Promise<string> {
  const id = randomUUID();
  const now = Date.now();
  await engine.openBodyStaging({
    id, kind: input.owner.kind, principalKind: input.owner.principalKind, principalId: input.owner.principalId, clientRequestId: randomUUID(),
    sourceId: input.sourceId, sourceIncarnation: await sourceIncarnation(engine, input.sourceId), slug: input.slug,
    pageId: input.live?.id ?? null, mode: input.live ? 'replace' : 'create', baseRevision: input.owner.baseRevision,
    baseGeneration: input.live?.generation ?? null, declaredBytes: input.declaredBytes, declaredSha256: null, reservedBytes: 0,
    idleExpiresAt: new Date(now + BODY_STAGING_IDLE_MS), hardExpiresAt: new Date(now + BODY_STAGING_HARD_MS),
  });
  return id;
}

/**
 * A full collection after each staging batch. A batch leaves garbage several times its payload (driver parameter
 * text, protocol buffers, decoded segment texts, chunk strings), and JSC sizes its collection threshold to the heap,
 * which PGLite's WASM memory makes large, so batches piled up uncollected: a 100 MiB import peaked ~1.1 GB on PGLite
 * without this and ~0.75 GB with it (scripts/bench-large-pages.ts). One collection of a small live heap per 4 MiB.
 */
function collectBatchGarbage(): void {
  Bun.gc(true);
}

/**
 * Pass 2 for one write: segment both regions, hash, stage texts, diff against
 * the live manifest, stage the changed manifest rows and (replace) the chunks
 * of every occurrence the new generation lacks. A failure aborts the staging.
 */
export async function prepareSegmentedBody(engine: BrainEngine, input: SegmentedBodyInput): Promise<PreparedSegmentedBody> {
  const stagingId = await openSegmentedStaging(engine, input);
  try {
    const prepared = await stageBody(engine, input, stagingId);
    await engine.setBodyStagingState(stagingId, 'prepared');
    return prepared;
  } catch (error) {
    await engine.setBodyStagingState(stagingId, 'aborted').catch(() => undefined);
    throw error;
  }
}

async function stageBody(engine: BrainEngine, input: SegmentedBodyInput, stagingId: string): Promise<PreparedSegmentedBody> {
  const live = input.live?.storage === 'segmented' ? input.live : null;
  const liveRows = live ? await engine.readManifest(live.id) : [];
  const byKey = new Map<string, ManifestRow[]>();
  for (const row of liveRows) {
    const key = occurrenceKey(row.sha256, row.entryState, regionTrust(live!.flags, row.region));
    const same = byKey.get(key);
    if (same) same.push(row); else byKey.set(key, [row]);
  }
  const writes = await segmentWriteScope(engine, input.sourceId, { kind: input.owner.principalKind as Principal['kind'], id: input.owner.principalId });
  const batchBytes = STAGE_BATCH_BYTES[engine.kind];
  const expectedGeneration = input.live?.generation ?? 0;
  const newGeneration = expectedGeneration + 1;
  const pageId = input.live?.id ?? 0;
  let prefixIntact = !!live && live.title === input.title && live.type === input.type;
  let hasher: ContentHashStream | null = null;
  const resume = (index: number) => index === 0 ? ContentHashStream.begin({ title: input.title, type: input.type })
    : ContentHashStream.fromState(liveRows[index - 1]!.hashState);
  const pending: SegmentTextInput[] = [];
  let pendingBytes = 0;
  const flushTexts = async () => {
    if (!pending.length) return;
    const batch = pending.splice(0);
    await writes(exec => exec.stageSegmentTexts(input.sourceId, batch));
    collectBatchGarbage();
    pendingBytes = 0;
    if (engine.kind === 'pglite') await new Promise(resolve => setImmediate(resolve));
  };
  const rows: ManifestRowInput[] = [];
  const used = new Set<ManifestRow>();
  const matched: Array<ManifestRow | null> = [];
  let texts = 0, byteStart = 0, lineStart = 0, truthBytes = 0;
  const leads: Record<BodyRegion, string> = { truth: '', timeline: '' };
  let hasProtected = false;
  let truthExit: EntryState = initialEntryState({ region: 'truth' });
  for (const region of ['truth', 'timeline'] as const) {
    const stream = region === 'truth' ? input.truth : input.timeline;
    const entry = region === 'truth' ? truthExit : timelineEntryState(truthExit);
    const end = region === 'truth' && input.hasTimeline ? 'region_end' : 'eof';
    let first = true;
    for await (const segment of segmentStream(stream, entry, { byteStart, lineStart, fenceTrust: regionTrust(input.flags, region), end })) {
      const seq = rows.length;
      if (first) { leads[region] = utf8Prefix(segment.bytes, BODY_LEAD_BYTES); first = false; }
      if (region === 'truth') truthExit = segment.exitState;
      const text = utf8.decode(segment.bytes);
      const key = occurrenceKey(segment.sha256, segment.entryState, segment.fenceTrust);
      const prior = liveRows[seq];
      const prefixRow = prefixIntact && prior && prior.region === region && Number(prior.byteStart) === byteStart
        && occurrenceKey(prior.sha256, prior.entryState, regionTrust(live!.flags, prior.region)) === key ? prior : null;
      let hashState: Uint8Array;
      if (prefixRow) hashState = prefixRow.hashState;
      else {
        hasher ??= resume(prefixIntact ? seq : 0);
        prefixIntact = false;
        if (region === 'truth') hasher.pushTruth(text); else hasher.pushTimeline(text);
        hashState = hasher.exportState();
      }
      const row: ManifestRowInput = {
        pageId, occurrenceId: 0, genFrom: newGeneration, seq, region, sourceId: input.sourceId, sha256: segment.sha256,
        byteStart, byteLen: segment.bytes.length, lineStart, lineCount: segment.lineCount, cutKind: segment.cutKind,
        entryState: segment.entryState as unknown as JsonObject, protectedRegions: segment.protectedRegions, factsSlots: segment.factsSlots,
        staticProjBytes: segment.staticProjBytes, staticProjLines: segment.staticProjLines, outline: segment.outline,
        dateMin: segment.dateMin, dateMax: segment.dateMax, hashState, stagingId,
      };
      const candidates = byKey.get(key)?.filter(candidate => !used.has(candidate)) ?? [];
      const match = candidates.find(candidate => candidate.seq === seq) ?? candidates[0] ?? null;
      if (match) used.add(match);
      matched.push(match);
      if (!match) {
        pending.push({ sha256: segment.sha256, body: segment.bytes, lineCount: segment.lineCount });
        pendingBytes += segment.bytes.length;
        texts++;
        if (pendingBytes >= batchBytes) await flushTexts();
      }
      if (segment.protectedRegions.length) hasProtected = true;
      rows.push(row);
      byteStart += segment.bytes.length;
      lineStart += segment.lineCount;
      if (region === 'truth') truthBytes += segment.bytes.length;
    }
  }
  await flushTexts();
  await faultPoint('segmented:texts_staged', { sourceId: input.sourceId });
  const contentHash = (hasher ?? resume(prefixIntact ? rows.length : 0)).finish({ frontmatter: input.frontmatter, tags: [...input.tags] });

  const fresh = rows.filter((_, i) => !matched[i]);
  const ids = fresh.length ? await engine.allocateBodyOccurrenceIds(fresh.length) : [];
  fresh.forEach((row, i) => { row.occurrenceId = ids[i]!; });
  const changed: ManifestRowInput[] = [];
  const closeOccurrences: number[] = [];
  rows.forEach((row, i) => {
    const match = matched[i];
    if (!match) { changed.push(row); return; }
    row.occurrenceId = Number(match.occurrenceId);
    if (input.live && rowUnchanged(match, row)) return;
    changed.push(row);
    closeOccurrences.push(row.occurrenceId);
  });
  const retireChunkOccurrences = liveRows.filter(row => !used.has(row)).map(row => Number(row.occurrenceId));
  closeOccurrences.push(...retireChunkOccurrences);
  const body: SegmentedBodyColumns = {
    content_hash: contentHash, body_bytes: byteStart, truth_bytes: truthBytes, body_lines: lineStart, segment_count: rows.length,
    segmenter_version: SEGMENTER_VERSION, truth_lead: leads.truth, timeline_lead: leads.timeline,
    body_flags: { ...input.flags, has_protected: hasProtected },
  };
  if (!input.live) {
    return { stagingId, expectedGeneration, newGeneration, createRows: rows, closeOccurrences: [], retireChunkOccurrences: [],
      unchunked: rows.length, body, bodyUnchanged: false, rows: { texts, manifest: rows.length, chunks: 0 }, stagedChunkIndexes: [] };
  }
  if (changed.length) await writes(exec => exec.stageManifestRows(changed));
  await faultPoint('segmented:manifest_staged', { sourceId: input.sourceId });
  const chunkable = await occurrencesWithoutChunks(engine, input.live.id, expectedGeneration, rows);
  const chunks = await stageOccurrenceChunks(engine, { pageId: input.live.id, sourceId: input.sourceId, slug: input.slug, generation: newGeneration,
    occurrences: chunkable, title: input.title, frontmatter: input.frontmatter, flags: body.body_flags, chunking: input.chunking,
    retiredOccurrences: retireChunkOccurrences });
  await faultPoint('segmented:chunks_staged', { sourceId: input.sourceId });
  const kept = new Set(rows.filter((_, i) => matched[i]).map(row => row.occurrenceId));
  retireChunkOccurrences.push(...chunkable.filter(row => kept.has(row.occurrenceId)).map(row => row.occurrenceId));
  return { stagingId, expectedGeneration, newGeneration, createRows: null, closeOccurrences, retireChunkOccurrences,
    unchunked: input.chunking.quarantined ? 0 : chunkable.length - chunks.occurrences, body,
    bodyUnchanged: changed.length === 0 && retireChunkOccurrences.length === 0, rows: { texts, manifest: changed.length, chunks: chunks.rows },
    stagedChunkIndexes: chunks.indexes };
}

/**
 * The rows of `rows` whose occurrence has no live chunk row at `generation`: new
 * occurrences, and kept ones a crashed or deferred projection never chunked.
 */
export async function occurrencesWithoutChunks(engine: Pick<BrainEngine, 'executeRaw'>, pageId: number, generation: number,
  rows: readonly ManifestRowInput[]): Promise<ManifestRowInput[]> {
  if (!rows.length) return [];
  const chunked = new Set((await engine.executeRaw<{ occurrence_id: number }>(`SELECT DISTINCT occurrence_id FROM content_chunks
    -- chunk-visibility-ok: write path; the generation predicate is explicit, at the generation the caller diffed against
    WHERE page_id=$1 AND occurrence_id=ANY($2::bigint[]) AND body_generation<=$3 AND retired_generation IS NULL`,
  [pageId, rows.map(row => row.occurrenceId), generation])).map(row => Number(row.occurrence_id)));
  return rows.filter(row => !chunked.has(row.occurrenceId));
}

/**
 * Chunk occurrences one text batch at a time (texts read back from
 * `page_segment_texts`), reuse vectors from the retired occurrences' rows, and
 * stage the chunk rows under `generation`. Shared by a replace's preparation
 * and the post-publication projection.
 */
export async function stageOccurrenceChunks(engine: BrainEngine, input: { pageId: number; sourceId: string; slug: string; generation: number;
  occurrences: readonly ManifestRowInput[]; title: string; frontmatter: JsonObject; flags: JsonObject; chunking: SegmentChunkingContext;
  retiredOccurrences: readonly number[];
  /** Projection: each batch inserts under the page guard, after re-reading which occurrences still lack rows, so two projections never both chunk one;
   *  a page whose generation moved past `generation` stops the projection before it inserts. */
  guarded?: boolean }): Promise<{ rows: number; occurrences: number; indexes: number[] }> {
  if (input.chunking.quarantined || !input.occurrences.length) return { rows: 0, occurrences: 0, indexes: [] };
  const batchBytes = STAGE_BATCH_BYTES[engine.kind];
  const fenceBudget = newFenceChunkBudget();
  let rows = 0, done = 0;
  const indexes: number[] = [];
  for (let start = 0; start < input.occurrences.length;) {
    let end = start, bytes = 0;
    while (end < input.occurrences.length && (end === start || bytes + input.occurrences[end]!.byteLen <= batchBytes)) bytes += input.occurrences[end++]!.byteLen;
    const batch = input.occurrences.slice(start, end);
    start = end;
    const texts = await engine.readSegmentTexts(input.sourceId, batch.map(row => row.sha256));
    const segments = batch.map(row => {
      const bytes = texts.get(hex(row.sha256));
      if (bytes === undefined) throw new Error(`Segment text ${hex(row.sha256)} of page ${input.pageId} is missing.`);
      const entryState = readEntryState(row.entryState);
      if (!entryState) throw new Error(`Manifest row ${row.occurrenceId} of page ${input.pageId} has an entry state of another version; resegment the page.`);
      const fenceTrust = regionTrust(input.flags, row.region);
      return { row, fenceTrust, segment: { region: row.region, bytes, byteStart: row.byteStart, entryState, fenceTrust, protectedRegions: row.protectedRegions as StoredRegion[] } };
    });
    const factsTexts = segments.flatMap(({ segment }) => segment.protectedRegions.some(region => region.kind === 'facts')
      ? segmentProjectionParts(utf8.decode(segment.bytes), segment.protectedRegions, segment.byteStart)
        .filter(part => part.kind === 'facts' && part.region?.open_start === undefined).map(part => part.text) : []);
    const overlay = factsTexts.length ? await loadFenceChunkOverlay(engine, { sourceId: input.sourceId, slug: input.slug, compiled_truth: factsTexts.join('\n') }) : undefined;
    const chunks: SegmentChunkInput[] = [];
    for (const { row, fenceTrust, segment } of segments) {
      for (const chunk of await prepareSegmentChunks(segment, { fenceTrust, frontmatter: input.frontmatter, overlay, fenceBudget })) {
        chunks.push({ ...chunk, occurrence_id: row.occurrenceId });
      }
    }
    if (chunks.length && input.retiredOccurrences.length) await reuseSegmentChunkVectors(engine, { pageId: input.pageId,
      retiredOccurrences: input.retiredOccurrences, chunks, title: input.title, corpusGeneration: input.chunking.corpusGeneration, tier: input.chunking.tier });
    if (chunks.length && !input.guarded) indexes.push(...await engine.stageSegmentChunks(input.pageId, input.generation, chunks));
    let moved = false;
    if (chunks.length && input.guarded) rows -= chunks.length - await engine.transaction(async tx => {
      await tx.lockPageKeys([{ sourceId: input.sourceId, slug: input.slug }]);
      const [page] = await tx.executeRaw<{ body_generation: number | string }>('SELECT body_generation FROM pages WHERE id=$1', [input.pageId]);
      if (Number(page?.body_generation) !== input.generation) { moved = true; return 0; }
      const open = new Set((await occurrencesWithoutChunks(tx, input.pageId, input.generation, batch)).map(row => row.occurrenceId));
      const still = chunks.filter(chunk => open.has(chunk.occurrence_id));
      if (still.length) await tx.stageSegmentChunks(input.pageId, input.generation, still);
      return still.length;
    });
    rows += chunks.length;
    if (moved) break;
    done += batch.length;
    collectBatchGarbage();
    if (engine.kind === 'pglite') await new Promise(resolve => setImmediate(resolve));
  }
  return { rows, occurrences: done, indexes };
}

/** The stored body of `pageId` at `generation` (default live), region by region, one segment at a time. */
export async function* readSegmentedBody(engine: BrainEngine, pageId: number, sourceId: string,
  opts: { generation?: number } = {}): AsyncIterable<{ region: BodyRegion; bytes: Uint8Array }> {
  const rows = await engine.readManifest(pageId, opts.generation === undefined ? {} : { generation: opts.generation });
  const batchBytes = STAGE_BATCH_BYTES[engine.kind];
  for (let start = 0; start < rows.length;) {
    let end = start, bytes = 0;
    while (end < rows.length && (end === start || bytes + rows[end]!.byteLen <= batchBytes)) bytes += rows[end++]!.byteLen;
    const batch = rows.slice(start, end);
    start = end;
    const texts = await engine.readSegmentTexts(sourceId, batch.map(row => row.sha256));
    for (const row of batch) {
      const text = texts.get(hex(row.sha256));
      if (text === undefined) throw new Error(`Segment text ${hex(row.sha256)} of page ${pageId} is missing.`);
      yield { region: row.region, bytes: text };
    }
  }
}

/** The whole body of a segmented page as strings. Only for pages within the single-string ceiling (callers check `body_bytes`). */
export async function materializeSegmentedBody(engine: BrainEngine, pageId: number, sourceId: string): Promise<{ compiled_truth: string; timeline: string }> {
  const parts: Record<BodyRegion, string[]> = { truth: [], timeline: [] };
  for await (const part of readSegmentedBody(engine, pageId, sourceId)) parts[part.region].push(utf8.decode(part.bytes));
  return { compiled_truth: parts.truth.join(''), timeline: parts.timeline.join('') };
}
