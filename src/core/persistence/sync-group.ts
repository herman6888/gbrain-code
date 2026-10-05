/**
 * #5984 bulk sync, the sync side (ENG-A3/A4, DX-A5/A8).
 *
 * A draining managed sync freezes the frozen head entry plus the directly
 * following eligible entries, records them in the cursor as one `group`
 * (the head stays in `pending`), admits every member in one transaction and
 * waits for the group. Each member keeps its own request, receipt and
 * failure attribution; the consumer publishes the group in one transaction
 * (group-publish.ts) or, member by member, in order. The cursor advances only
 * over the committed prefix, so a failed or still-pending member is handled
 * exactly like a single pending entry.
 */
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { OperationError } from '../ops/contract.ts';
import { admitWriteGroupInTransaction } from './journal.ts';
import { retryWriteAdmission } from './admission-retry.ts';
import { wouldWaiveEntry, type WaiverCursor, type WaiverEntry } from './sync-waivers.ts';
import type { WriteRequest } from './model.ts';
import type { SyncIntent } from './sync-prepare.ts';
import type { SyncAuthority } from './sync-authority.ts';

export interface BulkSettings { enabled: boolean; reason: string | null; size: number; maxTxnMs: number }
export interface BulkReport { enabled: boolean; reason: string | null; groups: number; grouped_pages: number; largest_group: number }

/** Flag > env > config > default (on), as for the other sync knobs (DX-A8). */
export async function resolveBulkSettings(engine: BrainEngine, noBulk: boolean | undefined): Promise<BulkSettings> {
  const env = process.env.GBRAIN_SYNC_BULK;
  const configured = await engine.getConfig('sync.bulk').catch(() => null);
  const size = await whole(engine, 'GBRAIN_SYNC_BULK_SIZE', 'sync.bulk_size', 16, 1, 64);
  const maxTxnMs = await whole(engine, 'GBRAIN_SYNC_BULK_MAX_TXN_MS', 'sync.bulk_max_txn_ms', 15_000, 100, 300_000);
  const reason = noBulk ? 'disabled by --no-bulk' : env === '0' || env === 'false' ? 'disabled by GBRAIN_SYNC_BULK=0'
    : env === undefined || env === '' ? (configured === 'false' || configured === '0' ? 'disabled by config sync.bulk=false' : null) : null;
  if (reason) return { enabled: false, reason, size, maxTxnMs };
  if (engine.kind !== 'postgres') return { enabled: false, reason: 'PGLite publishes without network round trips; bulk applies to Postgres', size, maxTxnMs };
  return { enabled: true, reason: null, size, maxTxnMs };
}
async function whole(engine: BrainEngine, env: string, key: string, fallback: number, min: number, max: number): Promise<number> {
  const raw = process.env[env] ? Number(process.env[env]) : await engine.getConfig(key).then(v => v == null ? undefined : Number(v)).catch(() => undefined);
  if (raw === undefined) return fallback;
  if (!Number.isFinite(raw) || raw < min || raw > max) throw new OperationError('invalid_params', `${key} (or ${env}) must be a whole number from ${min} to ${max}; got ${raw}.`,
    `Run gbrain config set ${key} ${fallback} (or unset ${env}), then retry.`);
  return Math.floor(raw);
}

/** Entries a group may carry: plain page imports and deletes; renames, company plans and the checkpoint stay single. */
export function groupableIntent(intent: SyncIntent): boolean {
  return (intent.kind === 'managed_sync_import' || intent.kind === 'managed_sync_delete') && !intent.renameFrom && !intent.companyApproval;
}

/**
 * Adaptive group size: as many members as fit the time budget at the last
 * observed per-member time from admission to commit, within the configured
 * maximum. Foreground writes queued behind a group wait at most about this
 * budget (sync.bulk_max_txn_ms); while a foreground write is queued on the
 * worktree, no group forms, so it is served before the next page (ENG-A5).
 */
export function nextGroupSize(settings: BulkSettings, perMemberMs: number | null): number {
  if (perMemberMs === null || perMemberMs <= 0) return Math.min(4, settings.size);
  return Math.max(1, Math.min(settings.size, Math.floor(settings.maxTxnMs / perMemberMs)));
}

/**
 * Followers for a group: frozen in manifest order after the head, four at a
 * time, stopping at the first entry that is not groupable, was overtaken by
 * another cursor, would be waived (the waiver handles it as a head) or is held (#5988).
 */
export async function freezeFollowers<P extends WaiverEntry & { rebound?: true }>(engine: BrainEngine, cursor: WaiverCursor & { entries: unknown[] }, config: GBrainConfig,
  count: number, freezeAt: (index: number) => Promise<P | null>): Promise<P[]> {
  const followers: P[] = [];
  for (let next = cursor.index + 1; followers.length < count && next < cursor.entries.length;) {
    const batch = Array.from({ length: Math.min(4, count - followers.length, cursor.entries.length - next) }, (_, i) => next + i);
    const frozen = await Promise.all(batch.map(async index => {
      const entry = await freezeAt(index);
      return !entry || entry.rebound || !groupableIntent(entry.intent) || await wouldWaiveEntry(engine, { ...cursor, index }, entry, config) ? null : entry;
    }));
    for (const entry of frozen) {
      if (!entry) return followers;
      followers.push(entry);
    }
    next += batch.length;
  }
  return followers;
}

/** Admits the group's members that have no request yet, in one transaction, while the cursor still holds this group. */
export async function admitGroup(engine: BrainEngine, members: WaiverEntry[], cursor: { sourceId: string; incarnation: string; binding: { worktree_id: string; topology_generation: string | number }; authority: SyncAuthority },
  cursorHolds: (tx: BrainEngine) => Promise<boolean>): Promise<WriteRequest[] | null> {
  const head = members[0]!;
  return retryWriteAdmission(head.requestId, remaining => engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true)",
      [`${Math.min(1000, remaining)}ms`, `${remaining}ms`]);
    const rows = await admitWriteGroupInTransaction(tx, members.map(member => ({ requestId: member.requestId, operation: 'submit_job',
      sourceId: cursor.sourceId, sourceIncarnation: cursor.incarnation, slug: member.slug, pageId: member.pageId,
      worktreeId: cursor.binding.worktree_id, topologyGeneration: cursor.binding.topology_generation,
      principal: cursor.authority.writer.principal, authority: cursor.authority.writer, callerIntent: member.intent, intent: member.intent })));
    if (!await cursorHolds(tx)) throw new GroupMoved();
    return rows;
  })).catch(error => { if (error instanceof GroupMoved) return null; throw error; });
}
class GroupMoved extends Error {}
