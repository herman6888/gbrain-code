/**
 * Managed-sync orphans (#5459): durable sync bookkeeping nothing current can
 * resume, clear or retire, which doctor reports as an unresolved failure forever.
 *
 * Four shapes:
 *
 * - `failure_row`: a `managed-sync-failure` row whose cursor key has no
 *   `managed-sync` cursor at all. `clearManagedSyncFailureAfterSuccess` clears a
 *   failure only on a success under the same key, and live runs succeed under a
 *   different key, so the row never clears.
 * - `unfinished_cursor`: a `managed-sync` cursor that is not `done` and that the
 *   live writer cannot resume: its recorded principal is not an active local
 *   writer ([R19]: the join is on the principal the cursor recorded, never on
 *   the current one), or it predates recorded sync options and a newer cursor
 *   for the same source and incarnation has since completed. A cursor whose
 *   pending request is still queued, running or recovering is never an orphan.
 * - `incarnation_retired` (#6518): an unfinished cursor, or a failure row, whose
 *   recorded source incarnation is no longer the source's (the source was
 *   re-pointed at a new checkout, or removed and added again). The cursor key
 *   digests the incarnation, so no current run selects it, and every
 *   incarnation-joined reader (`readManagedSyncFailures`, the two passes above,
 *   the clear paths) drops it; only the local ledger mirror still shows it.
 *   Archived sources are excluded; a live pending request still retains it.
 * - `mirror_only` (#6518): a row of the local compatibility ledger
 *   (`~/.gbrain/sync-failures.jsonl`) carrying a `managed_cursor_key` with no
 *   durable `managed-sync-failure` row under that key in any incarnation. The
 *   mirror is only ever pruned after a durable delete, so one whose durable row
 *   is already gone keeps `doctor --fast` warning forever.
 *
 * `classifyManagedSyncOrphans` is read-only (doctor consumes it); a failed
 * durable read throws instead of returning an empty list, so an unreachable
 * database never reads as "no orphans". `retireManagedSyncOrphan` deletes one
 * orphan's rows atomically with every predicate re-checked, so a cursor the
 * writer picked up meanwhile is kept and a mirror whose durable row appeared
 * since the preview is kept.
 */
import type { BrainEngine } from '../engine.ts';
import type { SqlEngine } from './model.ts';
import { clearManagedSyncFailure, loadSyncFailures } from '../sync-failure-ledger.ts';

export type ManagedSyncOrphanReason = 'no_cursor' | 'principal_unadoptable' | 'superseded' | 'incarnation_retired' | 'mirror_only';
export type ManagedSyncOrphanRetained = 'pending_request_live' | 'resumable';

export interface ManagedSyncOrphan {
  kind: 'failure_row' | 'unfinished_cursor' | 'mirror_row';
  cursor_key: string;
  source_id: string;
  /** The incarnation the row recorded; null for a ledger mirror row, which records none. */
  source_incarnation: string | null;
  run_id: string | null;
  /** The principal the cursor recorded (null for a failure row without one). */
  principal: { kind: string; id: string } | null;
  pending_request_id: string | null;
  pending_state: string | null;
  reason: ManagedSyncOrphanReason;
  updated_at: string;
}

export interface ManagedSyncOrphanClassification {
  orphans: ManagedSyncOrphan[];
  /** Unfinished cursors kept with why: a live pending request, or a cursor the live writer can still resume. */
  retained: Array<{ cursor_key: string; source_id: string; why: ManagedSyncOrphanRetained }>;
}

const TERMINAL = ['committed', 'failed', 'conflict', 'cancelled'];

interface CursorRow {
  cursor_key: string; source_id: string; source_incarnation: string; run_id: string | null;
  principal_kind: string | null; principal_id: string | null; has_sync_options: boolean;
  pending_request_id: string | null; pending_state: string | null;
  principal_live: boolean; superseded: boolean; updated_at: string;
}

/** Read-only. `sourceIds` narrows to those sources; null reads every active source. */
export async function classifyManagedSyncOrphans(engine: SqlEngine, sourceIds: string[] | null = null): Promise<ManagedSyncOrphanClassification> {
  const cursors = await engine.executeRaw<CursorRow>(`
    SELECT c.fingerprint AS cursor_key,s.id AS source_id,s.incarnation::text AS source_incarnation,c.completed_keys->0->>'runId' AS run_id,
      c.completed_keys->0->'authority'->'writer'->'principal'->>'kind' AS principal_kind,
      c.completed_keys->0->'authority'->'writer'->'principal'->>'id' AS principal_id,
      (c.completed_keys->0 ? 'syncOptions') AS has_sync_options,
      c.completed_keys->0->'pending'->>'requestId' AS pending_request_id,r.state AS pending_state,
      EXISTS(SELECT 1 FROM persistence_local_writers w WHERE w.revoked_at IS NULL
        AND w.id::text=c.completed_keys->0->'authority'->'writer'->'principal'->>'id'
        AND c.completed_keys->0->'authority'->'writer'->'principal'->>'kind' IN ('local_cli','local_stdio')) AS principal_live,
      EXISTS(SELECT 1 FROM op_checkpoints n WHERE n.op='managed-sync' AND n.fingerprint<>c.fingerprint
        AND n.completed_keys->0->>'sourceId'=s.id AND n.completed_keys->0->>'incarnation'=s.incarnation::text
        AND COALESCE(n.completed_keys->0->>'done','false')='true' AND n.updated_at>c.updated_at) AS superseded,
      to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
    FROM op_checkpoints c
    JOIN sources s ON s.id=c.completed_keys->0->>'sourceId' AND s.incarnation::text=c.completed_keys->0->>'incarnation' AND NOT COALESCE(s.archived,false)
    LEFT JOIN persistence_requests r ON r.source_id=s.id AND r.source_incarnation=s.incarnation
      AND r.request_id=(c.completed_keys->0->'pending'->>'requestId')::uuid
      AND r.principal_id=c.completed_keys->0->'authority'->'writer'->'principal'->>'id'
      AND r.principal_kind=c.completed_keys->0->'authority'->'writer'->'principal'->>'kind'
    WHERE c.op='managed-sync' AND COALESCE(c.completed_keys->0->>'done','false')<>'true'
      AND ($1::text[] IS NULL OR s.id=ANY($1::text[]))
    ORDER BY s.id,c.updated_at,c.fingerprint`, [sourceIds]);
  const orphans: ManagedSyncOrphan[] = [];
  const retained: ManagedSyncOrphanClassification['retained'] = [];
  for (const row of cursors) {
    const principal = row.principal_kind && row.principal_id ? { kind: row.principal_kind, id: row.principal_id } : null;
    if (row.pending_request_id && row.pending_state && !TERMINAL.includes(row.pending_state)) { retained.push({ cursor_key: row.cursor_key, source_id: row.source_id, why: 'pending_request_live' }); continue; }
    const reason: ManagedSyncOrphanReason | null = !row.principal_live ? 'principal_unadoptable' : !row.has_sync_options && row.superseded ? 'superseded' : null;
    if (!reason) { retained.push({ cursor_key: row.cursor_key, source_id: row.source_id, why: 'resumable' }); continue; }
    orphans.push({ kind: 'unfinished_cursor', cursor_key: row.cursor_key, source_id: row.source_id, source_incarnation: row.source_incarnation, run_id: row.run_id,
      principal, pending_request_id: row.pending_request_id, pending_state: row.pending_state, reason, updated_at: row.updated_at });
  }
  const failures = await engine.executeRaw<{ cursor_key: string; source_id: string; source_incarnation: string; run_id: string | null; request_id: string | null; updated_at: string }>(`
    SELECT f.fingerprint AS cursor_key,s.id AS source_id,s.incarnation::text AS source_incarnation,f.completed_keys->0->>'run_id' AS run_id,
      f.completed_keys->0->>'request_id' AS request_id,to_char(f.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
    FROM op_checkpoints f
    JOIN sources s ON s.id=f.completed_keys->0->>'source_id' AND s.incarnation::text=f.completed_keys->0->>'source_incarnation' AND NOT COALESCE(s.archived,false)
    WHERE f.op='managed-sync-failure' AND ($1::text[] IS NULL OR s.id=ANY($1::text[]))
      AND NOT EXISTS(SELECT 1 FROM op_checkpoints c WHERE c.op='managed-sync' AND c.fingerprint=f.fingerprint)
    ORDER BY s.id,f.fingerprint`, [sourceIds]);
  for (const row of failures) {
    orphans.push({ kind: 'failure_row', cursor_key: row.cursor_key, source_id: row.source_id, source_incarnation: row.source_incarnation, run_id: row.run_id,
      principal: null, pending_request_id: row.request_id, pending_state: null, reason: 'no_cursor', updated_at: row.updated_at });
  }
  // #6518: rows keyed under an incarnation the source no longer has. The join is on the source id alone; the live
  // pending-request guard stays, the live-writer guard does not apply (no current key can select these rows).
  const retiredCursors = await engine.executeRaw<Pick<CursorRow, 'cursor_key' | 'source_id' | 'source_incarnation' | 'run_id' | 'principal_kind' | 'principal_id' | 'pending_request_id' | 'pending_state' | 'updated_at'>>(`
    SELECT c.fingerprint AS cursor_key,s.id AS source_id,c.completed_keys->0->>'incarnation' AS source_incarnation,c.completed_keys->0->>'runId' AS run_id,
      c.completed_keys->0->'authority'->'writer'->'principal'->>'kind' AS principal_kind,
      c.completed_keys->0->'authority'->'writer'->'principal'->>'id' AS principal_id,
      c.completed_keys->0->'pending'->>'requestId' AS pending_request_id,r.state AS pending_state,
      to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
    FROM op_checkpoints c
    JOIN sources s ON s.id=c.completed_keys->0->>'sourceId' AND s.incarnation::text<>c.completed_keys->0->>'incarnation' AND NOT COALESCE(s.archived,false)
    LEFT JOIN persistence_requests r ON r.source_id=s.id AND r.request_id=(c.completed_keys->0->'pending'->>'requestId')::uuid
    WHERE c.op='managed-sync' AND COALESCE(c.completed_keys->0->>'done','false')<>'true'
      AND ($1::text[] IS NULL OR s.id=ANY($1::text[]))
    ORDER BY s.id,c.updated_at,c.fingerprint`, [sourceIds]);
  for (const row of retiredCursors) {
    if (row.pending_request_id && row.pending_state && !TERMINAL.includes(row.pending_state)) { retained.push({ cursor_key: row.cursor_key, source_id: row.source_id, why: 'pending_request_live' }); continue; }
    orphans.push({ kind: 'unfinished_cursor', cursor_key: row.cursor_key, source_id: row.source_id, source_incarnation: row.source_incarnation, run_id: row.run_id,
      principal: row.principal_kind && row.principal_id ? { kind: row.principal_kind, id: row.principal_id } : null, pending_request_id: row.pending_request_id, pending_state: row.pending_state,
      reason: 'incarnation_retired', updated_at: row.updated_at });
  }
  // A retired failure row rides with its unfinished cursor when one exists under its key (the cursor's retirement deletes it).
  const retiredFailures = await engine.executeRaw<{ cursor_key: string; source_id: string; source_incarnation: string; run_id: string | null; request_id: string | null; updated_at: string }>(`
    SELECT f.fingerprint AS cursor_key,s.id AS source_id,f.completed_keys->0->>'source_incarnation' AS source_incarnation,f.completed_keys->0->>'run_id' AS run_id,
      f.completed_keys->0->>'request_id' AS request_id,to_char(f.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
    FROM op_checkpoints f
    JOIN sources s ON s.id=f.completed_keys->0->>'source_id' AND s.incarnation::text<>f.completed_keys->0->>'source_incarnation' AND NOT COALESCE(s.archived,false)
    WHERE f.op='managed-sync-failure' AND ($1::text[] IS NULL OR s.id=ANY($1::text[]))
      AND NOT EXISTS(SELECT 1 FROM op_checkpoints c WHERE c.op='managed-sync' AND c.fingerprint=f.fingerprint AND COALESCE(c.completed_keys->0->>'done','false')<>'true')
    ORDER BY s.id,f.fingerprint`, [sourceIds]);
  for (const row of retiredFailures) {
    orphans.push({ kind: 'failure_row', cursor_key: row.cursor_key, source_id: row.source_id, source_incarnation: row.source_incarnation, run_id: row.run_id,
      principal: null, pending_request_id: row.request_id, pending_state: null, reason: 'incarnation_retired', updated_at: row.updated_at });
  }
  for (const row of await mirrorOnlyManagedFailures(engine, sourceIds)) {
    orphans.push({ kind: 'mirror_row', cursor_key: row.cursor_key, source_id: row.source_id, source_incarnation: null, run_id: row.run_id, principal: null,
      pending_request_id: row.request_id, pending_state: null, reason: 'mirror_only', updated_at: row.updated_at });
  }
  return { orphans, retained };
}

/**
 * #6518: local ledger rows carrying a `managed_cursor_key` with no durable `managed-sync-failure` row under that key
 * (any incarnation), on active sources. The durable read is the authority: when it fails, this throws rather than
 * naming every mirror as prunable. A ledger that cannot be read names nothing.
 */
export async function mirrorOnlyManagedFailures(engine: SqlEngine, sourceIds: string[] | null = null): Promise<Array<{ cursor_key: string; source_id: string; run_id: string | null; request_id: string | null; updated_at: string }>> {
  let rows: ReturnType<typeof loadSyncFailures> = [];
  try { rows = loadSyncFailures(); } catch { return []; }
  const mirrors = rows.filter(row => row.managed_cursor_key && (!sourceIds || sourceIds.includes(row.source_id)));
  if (!mirrors.length) return [];
  const archived = new Set((await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived = true')).map(row => row.id));
  const keys = [...new Set(mirrors.map(row => row.managed_cursor_key!))];
  const durable = new Set((await engine.executeRaw<{ fingerprint: string }>("SELECT fingerprint FROM op_checkpoints WHERE op='managed-sync-failure' AND fingerprint=ANY($1::text[])", [keys])).map(row => row.fingerprint));
  const seen = new Set<string>();
  const out: Array<{ cursor_key: string; source_id: string; run_id: string | null; request_id: string | null; updated_at: string }> = [];
  for (const row of mirrors) {
    const key = row.managed_cursor_key!;
    if (durable.has(key) || archived.has(row.source_id) || seen.has(key)) continue;
    seen.add(key);
    out.push({ cursor_key: key, source_id: row.source_id, run_id: row.run_id ?? null, request_id: row.request_id ?? null, updated_at: row.ts });
  }
  return out;
}

/** #6518: prunes a source's mirror-only ledger rows (the successful-sync path); returns how many it removed. */
export async function pruneMirrorOnlyManagedFailures(engine: SqlEngine, sourceId: string): Promise<number> {
  const rows = await mirrorOnlyManagedFailures(engine, [sourceId]);
  for (const row of rows) clearManagedSyncFailure(row.cursor_key);
  return rows.length;
}

/**
 * Delete one orphan's rows in one transaction: the cursor (unless the writer
 * finished or resumed it meanwhile, or its pending request went live), its
 * same-key failure row, and its manifest when no other cursor shares the run.
 * A `mirror_row` orphan deletes nothing durable: its ledger row goes only when
 * the durable read, repeated now, still finds no failure row under its key.
 * Returns what was removed; an empty result means the orphan is gone or no
 * longer qualifies and nothing was touched.
 *
 * #6518 [R18]: an `incarnation_retired` cursor is deleted when the source is
 * still active under a different incarnation at apply time; the live-writer
 * veto below is for a cursor the live writer could still resume, which no
 * retired key can be, so it does not apply. The live pending-request guard does.
 */
export async function retireManagedSyncOrphan(engine: BrainEngine, orphan: Pick<ManagedSyncOrphan, 'kind' | 'cursor_key' | 'run_id' | 'source_id' | 'source_incarnation' | 'reason'>): Promise<{ cursor: boolean; failure: boolean; manifest: boolean; mirror: boolean }> {
  const retired = orphan.reason === 'incarnation_retired';
  if (orphan.kind === 'mirror_row') {
    const durable = await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='managed-sync-failure' AND fingerprint=$1", [orphan.cursor_key]);
    if (durable.length) return { cursor: false, failure: false, manifest: false, mirror: false };
    return { cursor: false, failure: false, manifest: false, mirror: clearManagedSyncFailure(orphan.cursor_key) };
  }
  const removed = await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout','2000ms',true)");
    let cursor = false;
    if (orphan.kind === 'unfinished_cursor') {
      const rows = await tx.executeRaw(`
        DELETE FROM op_checkpoints c WHERE c.op='managed-sync' AND c.fingerprint=$1
          AND COALESCE(c.completed_keys->0->>'done','false')<>'true'
          AND c.completed_keys->0->>'sourceId'=$2 AND c.completed_keys->0->>'incarnation'=$3
          AND NOT EXISTS(SELECT 1 FROM persistence_requests r WHERE r.request_id=(c.completed_keys->0->'pending'->>'requestId')::uuid
            AND r.source_id=$2 AND r.state NOT IN ('committed','failed','conflict','cancelled'))
          AND ($4::boolean AND EXISTS(SELECT 1 FROM sources s WHERE s.id=$2 AND NOT COALESCE(s.archived,false) AND s.incarnation::text<>$3)
            OR NOT $4::boolean AND NOT EXISTS(SELECT 1 FROM persistence_local_writers w WHERE w.revoked_at IS NULL
              AND w.id::text=c.completed_keys->0->'authority'->'writer'->'principal'->>'id'
              AND c.completed_keys->0->'authority'->'writer'->'principal'->>'kind' IN ('local_cli','local_stdio')
              AND (c.completed_keys->0 ? 'syncOptions')))
        RETURNING fingerprint`, [orphan.cursor_key, orphan.source_id, orphan.source_incarnation, retired]);
      cursor = rows.length > 0;
      if (!cursor) return { cursor: false, failure: false, manifest: false, mirror: false };
    }
    const failure = (await tx.executeRaw(`DELETE FROM op_checkpoints f WHERE f.op='managed-sync-failure' AND f.fingerprint=$1
      AND NOT EXISTS(SELECT 1 FROM op_checkpoints c WHERE c.op='managed-sync' AND c.fingerprint=$1
        AND ($2::boolean IS DISTINCT FROM true OR COALESCE(c.completed_keys->0->>'done','false')<>'true'))
      AND ($2::boolean IS DISTINCT FROM true OR EXISTS(SELECT 1 FROM sources s WHERE s.id=f.completed_keys->0->>'source_id'
        AND NOT COALESCE(s.archived,false) AND s.incarnation::text<>f.completed_keys->0->>'source_incarnation'))
      RETURNING fingerprint`, [orphan.cursor_key, retired && orphan.kind === 'failure_row'])).length > 0;
    let manifest = false;
    if (orphan.run_id) {
      manifest = (await tx.executeRaw(`DELETE FROM op_checkpoints WHERE op='managed-sync-manifest' AND fingerprint=$1
        AND NOT EXISTS(SELECT 1 FROM op_checkpoints c WHERE c.op='managed-sync' AND c.completed_keys->0->>'runId'=$1) RETURNING fingerprint`, [orphan.run_id])).length > 0;
    }
    return { cursor, failure, manifest, mirror: false };
  });
  if (removed.cursor || removed.failure) try { removed.mirror = clearManagedSyncFailure(orphan.cursor_key); } catch { /* the local ledger is a compatibility mirror */ }
  return removed;
}
