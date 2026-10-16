/**
 * Segmented page storage (Wave B): the chunker for one segment, spec 4.1.
 *
 * Today's pipeline (markdown-chunks.ts) on one segment's projection instead of
 * a whole column: prose chunks, then the segment's recognized code-fence
 * chunks (truth segments only, as inline pages chunk only the truth's
 * fences), then its low-tier facts rows as marked chunks. Chunks never cross
 * the segment's bounds and carry no overlap from the previous segment, so a
 * segment's chunks depend only on its bytes, entry state and stored regions.
 *
 * The projection is built from the stored regions the segmenter computed
 * under the page's fence trust: takes, truncated tail and materialized
 * markers out, private keys as the projection token, and each facts region
 * rendered (world rows through the fence overlay) where its slot sits. A
 * facts region that crosses the segment's bounds is omitted, fail closed.
 * Inline pages keep prepareMarkdownChunks; this is a separate chunker identity.
 */
import { chunkProjectedText, chunkText } from '../chunkers/recursive.ts';
import { estimateEmbedTokens } from '../chunkers/token-estimate.ts';
import { resolveMaxChunkTokens } from '../embedding-input-limit.ts';
import { fencedCodeChunks, newFenceChunkBudget, type FenceChunkBudget } from '../markdown-chunks.ts';
import { fenceTrustMarker, markFenceChunk, splitFenceOverlay, type FenceChunkOverlay } from '../eligibility/fence-overlay.ts';
import { isQuarantined } from '../quarantine.ts';
import { renderFactsRegion } from '../remote-body.ts';
import { credentialSafeProjection } from '../credential-projection.ts';
import type { EntryState } from './entry-state.ts';
import type { SegmentChunkInput, BodyRegion } from './types.ts';
import { segmentProjectionParts, type StoredRegion } from './segmenter.ts';

/** Bump when the per-segment projection or chunk layout changes (stamped with the segmenter version). */
export const SEGMENTED_CHUNKER_VERSION = 1;

export type SegmentChunk = Omit<SegmentChunkInput, 'occurrence_id'>;

/** The parts of a SegmentOut (or a stored manifest row and its text) the chunker reads. */
export interface ChunkableSegment {
  region: BodyRegion;
  bytes: Uint8Array;
  byteStart: number;
  entryState: EntryState;
  fenceTrust: 'trusted' | 'void';
  protectedRegions: readonly StoredRegion[];
}

export interface SegmentChunkOptions {
  /** The page's current fence trust (body_flags.fence_trust); a segment whose regions were computed under the other trust is refused. */
  fenceTrust: 'trusted' | 'void';
  frontmatter?: Record<string, unknown> | null;
  maxChunkTokens?: number;
  overlay?: FenceChunkOverlay;
  /** One budget per page, shared by every segment's call, so the fence caps stay per page. */
  fenceBudget?: FenceChunkBudget;
}

interface MappedPart { projStart: number; projEnd: number; rawStart: number; rawEnd: number; linear: boolean }

export async function prepareSegmentChunks(segment: ChunkableSegment, opts: SegmentChunkOptions): Promise<SegmentChunk[]> {
  if (isQuarantined(opts.frontmatter)) return [];
  if (segment.fenceTrust !== opts.fenceTrust) {
    throw new Error(`segment_regions_stale: regions at byte ${segment.byteStart} were computed under fence trust ${segment.fenceTrust}, the page is ${opts.fenceTrust}; rescan before chunking`);
  }
  const maxTokens = opts.maxChunkTokens ?? resolveMaxChunkTokens();
  const raw = Buffer.from(segment.bytes).toString('utf8');
  const segEnd = segment.byteStart + segment.bytes.length;
  const pieces: string[] = [];
  const map: MappedPart[] = [];
  const factsTexts: string[] = [];
  let projBytes = 0;
  for (const part of segmentProjectionParts(raw, segment.protectedRegions, segment.byteStart)) {
    let text = '';
    if (part.kind === 'text' || part.kind === 'pem') text = part.text;
    else if (part.kind === 'facts' && part.region!.open_start === undefined) {
      factsTexts.push(part.text);
      text = credentialSafeProjection(renderFactsRegion(splitFenceOverlay(part.text, opts.overlay).main));
    }
    if (!text) continue;
    const bytes = Buffer.byteLength(text, 'utf8');
    map.push({ projStart: projBytes, projEnd: projBytes + bytes, rawStart: part.start, rawEnd: part.end, linear: part.kind === 'text' });
    pieces.push(text);
    projBytes += bytes;
  }
  const projection = pieces.join('');
  const source = segment.region === 'truth' ? 'compiled_truth' : 'timeline';
  const chunks: SegmentChunk[] = [];
  const push = (c: Omit<SegmentChunk, 'local_ordinal'>) => chunks.push({ ...c, local_ordinal: chunks.length });
  const wholeSegment = { raw_byte_start: segment.byteStart, raw_byte_end: segEnd };

  if (projection.trim()) {
    for (const c of chunkProjectedText(projection, { maxTokens, spans: true })) {
      if (c.byte_start === undefined || c.byte_end === undefined) {
        push({ chunk_text: c.text, chunk_source: source, ...wholeSegment });
        continue;
      }
      push({
        chunk_text: c.text,
        chunk_source: source,
        projected_byte_start: c.byte_start,
        projected_byte_end: c.byte_end,
        raw_byte_start: segment.byteStart + rawAt(map, c.byte_start, false),
        raw_byte_end: segment.byteStart + rawAt(map, c.byte_end, true),
      });
    }
    if (segment.region === 'truth') {
      const walk = segment.entryState.trusted.walk;
      const opener = walk.fence ? `${walk.fence.repeat(walk.len)}\n` : '';
      for (const c of await fencedCodeChunks(opener + projection, 0, opts.fenceBudget ?? newFenceChunkBudget())) {
        const { chunk_index: _index, ...rest } = c;
        push({ ...rest, ...wholeSegment });
      }
    }
  }

  if (factsTexts.length) {
    for (const { tier, unconfirmed, body } of splitFenceOverlay(factsTexts.join('\n'), opts.overlay).lowTier) {
      const room = Math.max(1, maxTokens - estimateEmbedTokens(fenceTrustMarker(tier, unconfirmed)) - 1);
      for (const c of chunkText(body, { maxTokens: room })) {
        push({ chunk_text: markFenceChunk(tier, c.text, unconfirmed), chunk_source: source, ...wholeSegment });
      }
    }
  }
  return chunks;
}

/**
 * Segment-relative stored byte of projection byte `pos`: exact inside kept
 * text; inside a token or a rendered facts table, the start (for a chunk
 * start) or end (for a chunk end) of the stored region it stands for.
 */
function rawAt(map: readonly MappedPart[], pos: number, end: boolean): number {
  let lo = 0;
  let hi = map.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (end ? map[mid]!.projStart < pos : map[mid]!.projStart <= pos) lo = mid; else hi = mid - 1;
  }
  const part = map[lo]!;
  if (part.linear) return part.rawStart + (pos - part.projStart);
  return end ? part.rawEnd : part.rawStart;
}
