/**
 * Segmented page projection (Wave B, lane 1d): chunk every live manifest
 * occurrence that has no chunk rows at the page's live body generation, stage
 * them, retire rows of occurrences no longer live, and seal the text
 * projection when the page is still at `expectedRevision` (or its current
 * revision). Reads one segment batch at a time. Used after a segmented create
 * (whose chunks cannot be staged before the page row exists), by the
 * projection job for a page left unsealed (crash, deferred retirement), and by
 * rebuilds.
 *
 * Retirement runs in bounded statements and deletes, as the flip does: rows of
 * occurrences outside the live generation, inline rows a promotion deferred,
 * and older duplicates of a live occurrence (a projection that raced a flip).
 * GC would delete a marked row at once, and a delete leaves the HNSW index
 * alone where marking rewrote each row's entry.
 */
import type { BrainEngine } from '../engine.ts';
import { isQuarantined } from '../quarantine.ts';
import { faultPoint } from '../persistence/fault-points.ts';
import { sealSegmentedPage } from '../persistence/segmented-apply.ts';
import { PROJECTION_RETRY_READY_SQL } from '../page-state/projections.ts';
import { occurrencesWithoutChunks, stageOccurrenceChunks } from './ingest.ts';
import { DEFAULT_FLIP_RETIRE_MAX_ROWS } from './limits.ts';
import type { JsonObject } from './types.ts';

export interface SegmentedProjectionResult { chunks: number; retired: number; sealed: boolean }

interface ProjectionPage {
  id: number; body_generation: number | string; knowledge_revision: string; text_projection_revision: string | null;
  title: string; frontmatter: JsonObject | null; body_flags: JsonObject | null; timeline_lead: string | null;
}

async function readProjectionPage(engine: Pick<BrainEngine, 'executeRaw'>, ref: { sourceId: string; slug: string }): Promise<ProjectionPage | null> {
  const [page] = await engine.executeRaw<ProjectionPage>(`SELECT id, body_generation, knowledge_revision::text AS knowledge_revision,
      text_projection_revision::text AS text_projection_revision, title, frontmatter, body_flags, timeline_lead
    FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL AND body_storage='segmented'`, [ref.sourceId, ref.slug]);
  return page ?? null;
}

/** Delete, in bounded batches, chunk rows the live generation does not hold: other occurrences, inline rows, older duplicates. */
async function retireStaleChunks(engine: Pick<BrainEngine, 'executeRaw' | 'kind'>, pageId: number, generation: number, live: readonly number[]): Promise<number> {
  let retired = 0;
  for (;;) {
    const rows = await engine.executeRaw<{ id: number }>(`DELETE FROM content_chunks c
      WHERE c.id IN (SELECT s.id FROM content_chunks s -- chunk-visibility-ok: retirement selects the rows the live generation does not hold
        WHERE s.page_id=$1 AND s.retired_generation IS NULL
        AND (s.body_generation IS NULL
          OR (s.body_generation<=$2 AND NOT (s.occurrence_id=ANY($3::bigint[])))
          OR (s.body_generation<=$2 AND EXISTS (SELECT 1 FROM content_chunks n WHERE n.page_id=s.page_id AND n.occurrence_id=s.occurrence_id
            AND n.retired_generation IS NULL AND n.body_generation>s.body_generation AND n.body_generation<=$2)))
        LIMIT $4)
      RETURNING c.id`, [pageId, generation, live, DEFAULT_FLIP_RETIRE_MAX_ROWS]);
    retired += rows.length;
    if (rows.length < DEFAULT_FLIP_RETIRE_MAX_ROWS) return retired;
    if (engine.kind === 'pglite') await new Promise(resolve => setImmediate(resolve));
  }
}

/** The projections of each engine's pages running in this process, by source and slug: the newest call of each page. */
const projecting = new WeakMap<BrainEngine, Map<string, Promise<unknown>>>();

/**
 * #6143: one projection of a page at a time in this process. A segmented
 * create's publication projects the page after commit while the resident
 * drain picks up the job its unsealed commit queued; run side by side, both
 * chunk the whole body and pin a pooled connection each, one waiting on the
 * other's page guard, for every batch. A call for a page another call is
 * projecting waits for it, and a page that call sealed has nothing left to project.
 */
export async function buildSegmentedProjection(engine: BrainEngine, ref: { sourceId: string; slug: string },
  opts: { expectedRevision?: string } = {}): Promise<SegmentedProjectionResult> {
  let pages = projecting.get(engine);
  if (!pages) projecting.set(engine, pages = new Map());
  const key = JSON.stringify([ref.sourceId, ref.slug]);
  const run = (pages.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => projectSegmentedPage(engine, ref, opts));
  pages.set(key, run);
  try { return await run; }
  finally { if (pages.get(key) === run) pages.delete(key); }
}

async function projectSegmentedPage(engine: BrainEngine, ref: { sourceId: string; slug: string },
  opts: { expectedRevision?: string }): Promise<SegmentedProjectionResult> {
  const page = await readProjectionPage(engine, ref);
  if (!page || (opts.expectedRevision !== undefined && page.knowledge_revision !== opts.expectedRevision)) return { chunks: 0, retired: 0, sealed: false };
  if (page.text_projection_revision === page.knowledge_revision) return { chunks: 0, retired: 0, sealed: true };
  const generation = Number(page.body_generation);
  const pageId = Number(page.id);
  const liveRows = await engine.readManifest(pageId);
  const retired = await retireStaleChunks(engine, pageId, generation, liveRows.map(row => Number(row.occurrenceId)));
  const frontmatter = page.frontmatter ?? {};
  const quarantined = isQuarantined(frontmatter);
  const unchunked = await occurrencesWithoutChunks(engine, pageId, generation, liveRows);
  const staged = await stageOccurrenceChunks(engine, { pageId, sourceId: ref.sourceId, slug: ref.slug, generation, occurrences: unchunked, title: page.title,
    frontmatter, flags: page.body_flags ?? {}, chunking: { quarantined, corpusGeneration: null, tier: 'none' }, retiredOccurrences: [], guarded: true });
  await faultPoint('segmented:projection_staged', { sourceId: ref.sourceId, slug: ref.slug });
  const sealed = await engine.transaction(async tx => {
    await tx.lockPageKeys([{ sourceId: ref.sourceId, slug: ref.slug }]);
    const current = await readProjectionPage(tx, ref);
    if (!current || current.knowledge_revision !== page.knowledge_revision || Number(current.body_generation) !== generation) return false;
    if (current.text_projection_revision !== current.knowledge_revision) await sealSegmentedPage(tx, pageId, current.timeline_lead ?? '');
    return true;
  });
  return { chunks: staged.rows, retired, sealed };
}

/**
 * The projection queue's segmented route: the queued rows of live segmented
 * pages (failed rows after their retry window), rebuilt by
 * `buildSegmentedProjection` at the queued revision. A failure marks the row
 * `rebuild_failed` like the inline route; a page whose revision moved is
 * left to the row the trigger queued for its new revision.
 */
export async function rebuildPendingSegmentedProjections(engine: BrainEngine, limit: number,
  opts: { deadlineMs?: number; now?: () => number } = {}): Promise<{ rebuilt: number; failed: number }> {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const jobs = await engine.executeRaw<{ source_id: string; source_incarnation: string; slug: string; revision: string }>(`SELECT s.id AS source_id,
      j.source_incarnation::text AS source_incarnation, j.slug, j.revision::text AS revision
    FROM page_projection_jobs j JOIN sources s ON s.incarnation=j.source_incarnation AND NOT s.archived
    JOIN pages p ON p.source_id=s.id AND p.slug=j.slug AND p.deleted_at IS NULL AND p.body_storage='segmented'
    WHERE ${PROJECTION_RETRY_READY_SQL} ORDER BY j.updated_at, j.slug LIMIT $1`, [Math.max(1, limit)]);
  let rebuilt = 0, failed = 0;
  for (const [index, job] of jobs.entries()) {
    if (opts.deadlineMs !== undefined && index > 0 && now() - startedAt >= opts.deadlineMs) break;
    try {
      if (!(await buildSegmentedProjection(engine, { sourceId: job.source_id, slug: job.slug }, { expectedRevision: job.revision })).sealed) continue;
      rebuilt++;
      await engine.executeRaw('DELETE FROM page_projection_jobs WHERE source_incarnation=$1::uuid AND slug=$2 AND revision=$3::uuid', [job.source_incarnation, job.slug, job.revision]);
    } catch {
      failed++;
      await engine.executeRaw(`UPDATE page_projection_jobs SET reason='rebuild_failed', updated_at=now()
        WHERE source_incarnation=$1::uuid AND slug=$2 AND revision=$3::uuid`, [job.source_incarnation, job.slug, job.revision]);
    }
  }
  return { rebuilt, failed };
}
