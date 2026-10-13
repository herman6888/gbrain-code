/**
 * Page purge (`gbrain delete <slug> --purge`, #5575 CEO-4/CEO-8): the same
 * live-store sweep as a fact purge, applied to one page inside the
 * coordinated delete transaction, plus a text-free page tombstone.
 *
 * Swept in the transaction: facts filed on the page (each tombstoned in
 * fact_purges), the page's takes (tombstoned in take_purges), take proposals,
 * open loops and core-edit notices keyed to the page, stored intents of
 * finished requests for the slug, and its `files` rows; takes, timeline
 * entries, chunks, versions, links and raw data go by foreign-key cascade
 * with the page row. Stored blobs are deleted after commit (`finishPagePurge`);
 * a blob that cannot be deleted is listed by storage path.
 *
 * `page_purges` keeps (source_id, content_hash, slug): the pages guard raises
 * typed `purged_content` when a page with that content hash is written again
 * under any slug, until `gbrain pages unpurge <slug>` clears it.
 *
 * #6511: the search for historical requests carrying the page's claims is an
 * O(journal) substring scan that no index serves, so it runs at preparation
 * (`preparePagePurge`, under the preparation budget) and the publication
 * transaction only reconciles the tail past the scanned ceiling and the rows
 * that were pending at scan time (`recheckRequestsCarrying`). A statement
 * timeout inside one of the remaining in-transaction lookups is deterministic
 * on a large journal, not contention: it ends the request `failed` with the
 * typed `purge_lookup_timeout` (the queue behind it moves) instead of being
 * released as `database_contention` and retried without bound.
 */

import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import type { WriteRequest } from './model.ts';
import { enterClaimStep, type ClaimPhaseClock } from './claim-phase.ts';
import { PERSISTENCE_REQUEST_SLUG_INTENT_INDEX } from './schema.ts';
import { readRequestIndexStates, REQUEST_INDEXES_REPAIR_COMMAND, type RequestIndexState } from './checkpoint-validation.ts';
import { faultPoint } from './fault-points.ts';
import { findRequestsForSlugs, recheckRequestsCarrying, redactRequestIntents, sweepRequestsCarrying, type JournalSweep } from './intent-redaction.ts';
import { dropPurgedFenceRows } from '../facts/purge-overlay.ts';
import { contentHash } from '../utils.ts';

export const PURGE_RESIDUALS = 'Removed from live stores: the page row with its chunks, versions, takes, timeline, links and raw data, the facts filed on it (tombstoned), '
  + 'its take proposals, open loops and core notices, stored write intents for the slug and its attached file records. Still out of reach: the brain repository\'s '
  + 'git history and every other clone or remote, Markdown exports and compiled context files, backups, provider copies (embeddings, decisions), and deleted rows '
  + 'in database pages and the write-ahead log until vacuum. Rotate any exposed credential.';

function hostOnly(command: string) {
  return opError('trusted_local_only', 'Page purge tombstones are managed only from the trusted local CLI on the brain host.',
    `Ask the user to run \`${command}\` on the brain host.`, { legacy_error: 'permission_denied' });
}

/**
 * What the post-commit receipt needs and the journal must never hold: the purged page's claims (verification
 * needles) and row ids, keyed by `<source_id>:<request_id>`, in this process only. A receipt built where the
 * map has no entry reports the prose probe as unverified.
 */
const purgeContext = new Map<string, { needles: string[]; factIds: number[]; pageId: number; paths: string[] }>();
const PURGE_CONTEXT_LIMIT = 64;
const purgeReceipts = new Map<string, { receipt: Record<string, unknown>; purge: Record<string, unknown> }>();

/** The page's claims (facts filed on it, its takes) that the journal sweep searches for, bounded, trimmed, deduplicated. */
async function readPurgeClaims(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, slug: string, pageId: number) {
  const factRows = await engine.executeRaw<{ id: number; fact: string }>('SELECT id,fact FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 ORDER BY id LIMIT 1000', [sourceId, slug]);
  const takeRows = await engine.executeRaw<{ id: number; claim: string }>('SELECT id,claim FROM takes WHERE page_id=$1 ORDER BY id LIMIT 1000', [pageId]);
  const needles = [...new Set([...factRows.map(f => f.fact), ...takeRows.map(t => t.claim)].map(t => t.trim()).filter(t => t.length >= 8))].slice(0, 32);
  return { factRows, takeRows, needles };
}

/** What the delete preparation hands the purge apply: the claims it searched for, the journal census, and the slug index's state for the failure hint. */
export interface PreparedPagePurge { needles: string[]; sweep: JournalSweep; slugIndex: RequestIndexState['state'] }
/**
 * #6511: at preparation, before the root lock and outside any transaction: the page's claims, the slug index's state and
 * the keyset journal sweep under the preparation budget (the clock between chunks; `boundedReads` on Postgres).
 */
export async function preparePagePurge(engine: BrainEngine, row: WriteRequest, snapshot: PageSnapshot, clock: ClaimPhaseClock | undefined): Promise<PreparedPagePurge> {
  enterClaimStep(clock, 'purge_claims', undefined, 'db');
  const { needles } = await readPurgeClaims(engine, row.source_id, snapshot.page.slug, snapshot.page.id);
  const [slugIndex] = await readRequestIndexStates(engine, [PERSISTENCE_REQUEST_SLUG_INTENT_INDEX]);
  const sweep = await sweepRequestsCarrying(engine, row.source_id, needles, { clock, exclude: row.id,
    onChunk: () => faultPoint('purge:sweep_chunk', { requestId: row.request_id, sourceId: row.source_id, operation: row.operation }) });
  return { needles, sweep, slugIndex: slugIndex?.state ?? 'missing' };
}

/** The in-transaction journal lookups a statement timeout ends as `purge_lookup_timeout` (also the purge's fault-point seams). */
export type PurgeLookupPoint = 'slug_lookup' | 'tail_recheck' | 'pending_recheck' | 'redaction_read';
const LOOKUP_LABEL: Record<PurgeLookupPoint, string> = { slug_lookup: 'lookup of stored intents for the slug', tail_recheck: 're-check of requests admitted after its preparation scan',
  pending_recheck: 're-check of requests that were pending at its preparation scan', redaction_read: 'locking read of the requests to redact' };
export const PURGE_LOOKUP_TIMEOUT_MESSAGE = 'This purge could not finish; later writes to the source can move again. Do not assume the requested content was erased.';
/** [R6] The failure's `fix` names the index repair only when the slug index is missing or invalid; otherwise a fresh request id. */
export function purgeLookupTimeout(row: Pick<WriteRequest, 'request_id' | 'slug' | 'source_id'>, point: PurgeLookupPoint, slugIndex: RequestIndexState['state']): OperationError {
  const broken = slugIndex === 'missing' || slugIndex === 'invalid';
  const next = broken
    ? `The request-table slug index ${PERSISTENCE_REQUEST_SLUG_INTENT_INDEX.name} is ${slugIndex === 'invalid' ? 'INVALID' : 'missing'}: rebuild it (${REQUEST_INDEXES_REPAIR_COMMAND}), then submit the purge again with a new request_id.`
    : 'Submit the purge again with a new request_id (a retry with the same id returns this failure); if it times out again, report the request and attach the persistence_request_indexes and persistence_request_growth entries of gbrain doctor --json.';
  // The journal keeps code and message only, so the next step rides the message (the receipt is what `gbrain write-request` shows).
  return opError('purge_lookup_timeout', `${PURGE_LOOKUP_TIMEOUT_MESSAGE} ${next}`,
    `The purge's ${LOOKUP_LABEL[point]} (request ${row.request_id}, page ${row.slug} in source ${row.source_id}) exceeded the publication transaction's statement budget, so the transaction rolled back: `
    + 'no row, file or tombstone of the page was removed and nothing in the journal was redacted.',
    { fix: broken
      ? { argv: ['gbrain', 'repair', 'request-indexes', '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Previews the missing or invalid request-table indexes without changing anything.' }
      : readFix(`Reads request ${row.request_id}'s durable receipt: its state and recorded error, read-only.`, { argv: ['gbrain', 'write-request', '--', row.request_id] }) });
}
/** Runs one in-transaction journal lookup behind its fault-point seam; a 57014 from it is the terminal typed failure, never transient contention. */
async function journalLookup<T>(row: WriteRequest, point: PurgeLookupPoint, slugIndex: RequestIndexState['state'], fn: () => Promise<T>): Promise<T> {
  try {
    await faultPoint(`purge:${point}`, { requestId: row.request_id, sourceId: row.source_id, operation: row.operation });
    return await fn();
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== '57014') throw error;
    throw purgeLookupTimeout(row, point, slugIndex);
  }
}

/** Inside the coordinated delete transaction, before the page row is deleted. */
export async function purgePageInTransaction(tx: BrainEngine, row: WriteRequest, snapshot: PageSnapshot, prepared: PreparedPagePurge): Promise<Record<string, unknown>> {
  const page = snapshot.page, sourceId = row.source_id, slug = page.slug;
  const actor = `${row.principal_kind}:${row.principal_id}`;
  const [stored] = await tx.executeRaw<{ content_hash: string | null }>('SELECT content_hash FROM pages WHERE id=$1', [page.id]);
  const storedHash = stored?.content_hash ?? null;
  await tx.executeRaw(`INSERT INTO fact_purges(source_id,visibility,subject,fact_hash,request_id,actor,reason)
    SELECT DISTINCT source_id,visibility,COALESCE(entity_slug,'*'),gbrain_fact_fingerprint(fact),$3::uuid,$4,'page purge'
    FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 ON CONFLICT DO NOTHING`, [sourceId, slug, row.id, actor]);
  await tx.executeRaw(`INSERT INTO take_purges(source_id,subject,claim_hash,request_id)
    SELECT DISTINCT $1,$2,gbrain_fact_fingerprint(claim),$4::uuid FROM takes WHERE page_id=$3 ON CONFLICT DO NOTHING`, [sourceId, slug, page.id, row.id]);
  // Tombstone the content hash of the page and of every retained version, each as an import of that body would
  // compute it and as the purge overlay leaves it (the overlay now drops this page's tombstoned fence rows), so
  // neither the stale file nor an older version of it imports again under any slug.
  const versions = await tx.executeRaw<Record<string, unknown>>(`SELECT title,type,compiled_truth,timeline,frontmatter,tags,source_path FROM page_versions
    WHERE page_id=$1 ORDER BY id DESC LIMIT 1000`, [page.id]);
  const bodies = [{ ...page, tags: snapshot.tags }, ...versions.map(v => ({ title: String(v.title ?? ''), type: v.type as never,
    compiled_truth: String(v.compiled_truth ?? ''), timeline: String(v.timeline ?? ''), frontmatter: (v.frontmatter ?? {}) as Record<string, unknown>,
    tags: Array.isArray(v.tags) ? v.tags.map(String) : [] }))];
  const hashes = new Set<string>(storedHash ? [storedHash] : []);
  for (const body of bodies) {
    hashes.add(contentHash(body));
    hashes.add(contentHash({ ...body, compiled_truth: await dropPurgedFenceRows(tx, sourceId, body.compiled_truth, slug),
      timeline: await dropPurgedFenceRows(tx, sourceId, body.timeline ?? '', slug) }));
  }
  await tx.executeRaw(`INSERT INTO page_purges(source_id,content_hash,slug,request_id) SELECT $1,h,$3,$4::uuid FROM unnest($2::text[]) AS h
    ON CONFLICT (source_id,content_hash) DO UPDATE SET slug=EXCLUDED.slug,request_id=EXCLUDED.request_id,purged_at=now()`, [sourceId, [...hashes], slug, row.id]);
  const { factRows, takeRows, needles } = await readPurgeClaims(tx, sourceId, slug, page.id);
  const factIds = factRows.map(f => Number(f.id)), takeIds = takeRows.map(t => Number(t.id));
  const count = async (sql: string, params: unknown[]) => (await tx.executeRaw(sql, params)).length;
  const refs = factIds.map(String);
  const removed: Record<string, number> = {
    decide_review_queue: await count('DELETE FROM decide_review_queue WHERE source_id=$1 AND (a_ref=ANY($2::text[]) OR b_ref=ANY($2::text[])) RETURNING 1', [sourceId, refs]),
    decide_review_proposals: await count('DELETE FROM decide_review_proposals WHERE source_id=$1 AND (a_ref=ANY($2::text[]) OR b_ref=ANY($2::text[])) RETURNING 1', [sourceId, refs]),
    decide_proposals: await count('DELETE FROM decide_proposals WHERE source_id=$1 AND (new_fact_id=ANY($2::bigint[]) OR old_fact_id=ANY($2::bigint[])) RETURNING 1', [sourceId, factIds]),
    trust_proposals: await count(`DELETE FROM trust_proposals WHERE source_id=$1 AND ((target_table='pages' AND target_id=$2) OR (related_table='pages' AND related_id=$2)
      OR (target_table='facts' AND target_id=ANY($3::bigint[])) OR (related_table='facts' AND related_id=ANY($3::bigint[]))
      OR (target_table='takes' AND target_id=ANY($4::bigint[])) OR (related_table='takes' AND related_id=ANY($4::bigint[]))) RETURNING 1`, [sourceId, page.id, factIds, takeIds]),
  };
  const holds = (await tx.executeRaw<{ id: string }>('DELETE FROM write_gate_holds WHERE source_id=$1 AND slug=$2 RETURNING id::text AS id', [sourceId, slug])).map(h => h.id);
  removed.write_gate_holds = holds.length;
  removed.write_gate_receipts = await count(`DELETE FROM write_gate_receipts WHERE (target_table='pages' AND target_id=$1) OR (target_table='facts' AND target_id=ANY($2::text[]))
    OR (target_table='takes' AND target_id=ANY($3::text[])) OR (target_table='write_gate_holds' AND target_id=ANY($4::text[])) RETURNING 1`,
  [String(page.id), refs, takeIds.map(String), holds]);
  removed.query_cache = await count('DELETE FROM query_cache RETURNING 1', []);
  removed.facts = await count('DELETE FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 RETURNING 1', [sourceId, slug]);
  removed.take_proposals = await count('DELETE FROM take_proposals WHERE source_id=$1 AND page_slug=$2 RETURNING 1', [sourceId, slug]);
  removed.open_loops = await count('DELETE FROM open_loops WHERE source_id=$1 AND page_slug=$2 RETURNING 1', [sourceId, slug]);
  removed.core_edit_notices = await count('DELETE FROM core_edit_notices WHERE source_id=$1 AND slug=$2 RETURNING 1', [sourceId, slug]);
  // #6511 [R2]: the preparation sweep's targets, plus the tail past its ceiling and the rows pending at scan time, re-tested here.
  const lookup = <T>(point: PurgeLookupPoint, fn: () => Promise<T>) => journalLookup(row, point, prepared.slugIndex, fn);
  const recheck = await lookup('tail_recheck', () => recheckRequestsCarrying(tx, sourceId, needles, prepared.sweep,
    { exclude: row.id, beforePending: () => faultPoint('purge:pending_recheck', { requestId: row.request_id, sourceId, operation: row.operation }) }));
  const forSlug = await lookup('slug_lookup', () => findRequestsForSlugs(tx, sourceId, [slug]));
  const requests = [...new Map([...forSlug, ...prepared.sweep.targets, ...recheck.targets].map(r => [r.id, r])).values()];
  removed.persistence_requests = await lookup('redaction_read', () => redactRequestIntents(tx, requests, row.id, { skipPending: true, needles }));
  const journalSweep = { scanned: prepared.sweep.scanned, ceiling: prepared.sweep.ceiling, tail: recheck.tail, pending_rechecked: recheck.pendingRechecked,
    complete: prepared.sweep.complete && recheck.complete };
  const files = await tx.executeRaw<{ storage_path: string }>(`DELETE FROM files WHERE (page_id=$1 OR (page_slug=$2 AND (source_id=$3 OR source_id IS NULL)))
    RETURNING storage_path`, [page.id, slug, sourceId]);
  removed.files = files.length;
  const [cascade] = await tx.executeRaw<{ chunks: number; versions: number; takes: number; timeline: number }>(`SELECT
    (SELECT count(*)::int FROM content_chunks WHERE page_id=$1) AS chunks, (SELECT count(*)::int FROM page_versions WHERE page_id=$1) AS versions,
    (SELECT count(*)::int FROM takes WHERE page_id=$1) AS takes, (SELECT count(*)::int FROM timeline_entries WHERE page_id=$1) AS timeline`, [page.id]);
  Object.assign(removed, { content_chunks: cascade?.chunks ?? 0, page_versions: cascade?.versions ?? 0, takes: cascade?.takes ?? 0, timeline_entries: cascade?.timeline ?? 0, pages: 1 });
  const paths = [...new Set([page.source_path, ...versions.map(v => v.source_path as string | null)].filter((p): p is string => !!p))].slice(0, 64);
  await tx.deletePage(slug, { sourceId });
  const key = `${sourceId}:${row.request_id}`;
  purgeContext.delete(key);
  purgeContext.set(key, { needles, factIds, pageId: page.id, paths });
  while (purgeContext.size > PURGE_CONTEXT_LIMIT) purgeContext.delete(purgeContext.keys().next().value!);
  return { status: 'purged', slug, source_id: sourceId, residuals: PURGE_RESIDUALS, journal_sweep: journalSweep,
    purge: { content_hash8: storedHash?.slice(0, 8) ?? null, tombstoned: hashes.size > 0, content_hashes_tombstoned: hashes.size, removed,
      blobs: files.map(f => f.storage_path).filter(Boolean) } };
}

/**
 * After commit: delete the purged page's stored blobs (any that remain are listed by storage path), then build the
 * store-by-store receipt the fact purge returns: residuals first, every swept inventory store with a status.
 */
export async function finishPagePurge(ctx: Pick<OperationContext, 'engine' | 'config'>, result: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (result.status !== 'purged') return result;
  const sourceId = String(result.source_id), slug = String(result.slug), key = `${sourceId}:${String(result.request_id)}`;
  // A same-id replay in this process returns what the purge call returned (blobs and verification are not re-run).
  const finished = purgeReceipts.get(key);
  if (finished) return { ...result, ...finished };
  const purge = (result.purge ?? {}) as { blobs?: string[]; removed?: Record<string, number> };
  const remaining: string[] = [];
  if (purge.blobs?.length) {
    try {
      const { createStorage } = await import('../storage.ts');
      const storage = await createStorage((ctx.config as { storage?: unknown } | undefined)?.storage as never);
      for (const path of purge.blobs) { try { await storage.delete(path); } catch { remaining.push(path); } }
    } catch { remaining.push(...purge.blobs); }
  }
  const { verifyPagePurge } = await import('../facts/purge-verify.ts');
  const receipt = await verifyPagePurge(ctx.engine, { sourceId, slug, requestId: String(result.request_id), removed: purge.removed ?? {},
    blobsRemaining: remaining, context: purgeContext.get(key) ?? null });
  purgeContext.delete(key);
  // `residuals` stays the delete_page prose string; the store-by-store receipt (same shape as purge_fact's) rides as `receipt`.
  const extra = { receipt, purge: { ...purge, blobs_deleted: (purge.blobs?.length ?? 0) - remaining.length, blobs_remaining: remaining } };
  purgeReceipts.set(key, extra);
  while (purgeReceipts.size > PURGE_CONTEXT_LIMIT) purgeReceipts.delete(purgeReceipts.keys().next().value!);
  return { ...result, ...extra };
}

/** Prefetch for import screens: every page tombstone of a source, content hash -> slug (bounded). */
export async function readPagePurgeTombstones(engine: BrainEngine, sourceId: string, limit = 10_000): Promise<Map<string, string>> {
  const rows = await engine.executeRaw<{ content_hash: string; slug: string }>('SELECT content_hash,slug FROM page_purges WHERE source_id=$1 ORDER BY purged_at DESC LIMIT $2', [sourceId, limit]);
  return new Map(rows.map(r => [r.content_hash, r.slug]));
}

export async function listPagePurges(ctx: OperationContext, p: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (ctx.remote !== false) throw hostOnly('gbrain pages purges list');
  const limit = Math.max(1, Math.min(1000, Number(p.limit ?? 100) || 100));
  const rows = await ctx.engine.executeRaw<{ source_id: string; slug: string; content_hash: string; request_id: string | null; purged_at: string }>(`SELECT source_id,slug,
      content_hash,request_id::text,purged_at FROM page_purges WHERE ($1::text IS NULL OR source_id=$1) ORDER BY purged_at DESC LIMIT $2`,
  [typeof p.source_id === 'string' ? p.source_id : null, limit]);
  return { purges: rows.map(r => ({ source_id: r.source_id, slug: r.slug, content_hash8: r.content_hash.slice(0, 8), request_id: r.request_id,
    purged_at: new Date(r.purged_at).toISOString() })), next: rows.length ? 'Clear one with gbrain pages unpurge <slug> [--source <id>].' : 'No page purge tombstones.' };
}

export async function unpurgePage(ctx: OperationContext, p: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (ctx.remote !== false) throw hostOnly('gbrain pages unpurge <slug>');
  const slug = typeof p.slug === 'string' ? p.slug : '';
  if (!slug) throw opError('invalid_params', 'unpurge needs a slug.', 'Pass the slug gbrain pages purges list shows.');
  const sourceId = typeof p.source_id === 'string' ? p.source_id : ctx.sourceId ?? 'default';
  return ctx.engine.transaction(async tx => {
    await tx.executeRaw('SELECT id FROM sources WHERE id=$1 FOR UPDATE', [sourceId]);
    const cleared = await tx.executeRaw<{ request_id: string | null }>('DELETE FROM page_purges WHERE source_id=$1 AND slug=$2 RETURNING request_id::text', [sourceId, slug]);
    const requests = cleared.map(r => r.request_id).filter((id): id is string => !!id);
    const facts = requests.length ? (await tx.executeRaw('DELETE FROM fact_purges WHERE source_id=$1 AND request_id=ANY($2::uuid[]) RETURNING 1', [sourceId, requests])).length : 0;
    const takes = requests.length ? (await tx.executeRaw('DELETE FROM take_purges WHERE source_id=$1 AND request_id=ANY($2::uuid[]) RETURNING 1', [sourceId, requests])).length : 0;
    return { slug, source_id: sourceId, cleared: cleared.length, fact_tombstones_cleared: facts, take_tombstones_cleared: takes,
      next: cleared.length ? `The next import of ${slug} with its old content is accepted (gbrain sync --source ${sourceId} --no-pull). Nothing was restored.` : `No purge tombstone is recorded for ${slug} in source ${sourceId}.` };
  });
}
