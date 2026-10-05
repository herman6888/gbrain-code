/**
 * #5984 bulk sync: publishes a claimed group of consecutive managed-sync page
 * requests in one transaction (ENG-A3/A4).
 *
 * Every member keeps its own request row, authorization, page guard,
 * visibility check, attribution, effects and receipt; only the per-transaction
 * work is shared: the worktree lock, the recovery and capacity checks, the
 * ownership guard and the counter and request locks. Counters are locked after
 * the members are applied and before their request rows, so the brain-wide
 * counter row is held only for the completion statements (ENG-A5). A group
 * therefore takes page guards before counters, the reverse of single
 * publication and of forget/mirror recovery; a deadlock with one of those on
 * the same page is detected by Postgres (40P01) and both sides retry: the
 * group falls back to single publication, admission and withdrawal retry.
 *
 * The group is all-or-nothing. Any failure rolls the transaction back and
 * returns null; the caller then publishes the members one at a time, so a
 * failure is attributed to its own page and no later member overtakes it.
 * Only database-only managed-sync page members qualify; their sync
 * validation includes the knowledge-publication guard. A member with a file,
 * a skill bundle or a source-exclusive checkpoint takes the single path.
 */
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { authorizeStoredRequest } from './authority.ts';
import { localHostId } from './identity.ts';
import { acquireWorktree, getWorktreeBinding, guardOwnership } from './ownership.ts';
import { completeWrite, getWriteRequestById, lockCounters, releaseUnpublishedClaim, renewGroupClaims } from './journal.ts';
import { principalKey, requestPrincipal, type WriteRequest } from './model.ts';
import { setMemberAttribution, withCoordinatedWrite } from './context.ts';
import { requestAttribution } from './attribution.ts';
import { tryAcquirePublicationCapacity } from './pool-capacity.ts';
import { queuePublicationEffects } from './effect-journal.ts';
import { assertUnboundPublication, classifyUnboundPage } from './unbound-source.ts';
import { declarePersistenceProtocol } from './protocol.ts';
import { classifyMirrorPage } from './mirror-read-only.ts';
import { decoratePublicationOutcome, finishUnpublishedFailure, publishMutation, type PreparedMutation } from './coordinator.ts';

/** Whether a prepared member can share a group transaction. */
export function groupable(row: WriteRequest, prepared: PreparedMutation): boolean {
  return row.operation === 'submit_job' && (row.intent?.kind === 'managed_sync_import' || row.intent?.kind === 'managed_sync_delete')
    && (row.target_kind ?? 'page') === 'page' && prepared.target !== 'skill_bundle' && !prepared.file && !prepared.sourceExclusive && typeof prepared.validate === 'function';
}

/** Publishes the whole group or nothing; null means the transaction did not commit and the claims are untouched. */
export async function publishGroup(engine: BrainEngine, rows: WriteRequest[], prepared: PreparedMutation[], hostId = localHostId()): Promise<WriteRequest[] | null> {
  const head = rows[0];
  if (!head?.worktree_id || rows.some((row, i) => row.worktree_id !== head.worktree_id || !groupable(row, prepared[i]!))) return null;
  const binding = await getWorktreeBinding(engine, head.source_id, hostId);
  if (!binding || binding.owner_host_id !== hostId || !binding.local_path) return null;
  const lock = await acquireWorktree(binding, 0, undefined, engine);
  if (!lock) return null;
  let releaseCapacity: (() => void) | null = null;
  try {
    const blocked = await engine.executeRaw(`SELECT 1 FROM persistence_requests WHERE worktree_id=$1::uuid AND NOT (id=ANY($2::uuid[])) AND recovery IS NOT NULL
      UNION ALL SELECT 1 FROM persistence_effects WHERE worktree_id=$1::uuid AND recovery IS NOT NULL LIMIT 1`, [head.worktree_id, rows.map(row => row.id)]);
    if (blocked.length) return null;
    releaseCapacity = tryAcquirePublicationCapacity(engine);
    if (!releaseCapacity) return null;
    return await engine.transaction(async tx => {
      await declarePersistenceProtocol(tx);
      await tx.executeRaw("SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout','1s',true),set_config('statement_timeout','5s',true)");
      const live = await guardOwnership(tx, head, hostId);
      if (String(live?.owner_epoch) !== String(binding.owner_epoch)) throw new OperationError('owner_unavailable', 'Owner epoch changed before publication.', 'Inspect the source owner with gbrain sources writer status; do not claim or transfer the source to push this write.');
      await tx.lockPageKeys(rows.flatMap((row, i) => [{ sourceId: row.source_id, slug: row.slug }, ...(prepared[i]!.additionalPageKeys ?? [])]));
      const outcomes: Record<string, unknown>[] = [];
      // One coordinated write for the group; each member is the attributed actor of what it writes.
      await withCoordinatedWrite(tx, [head.source_id], async () => {
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i]!, member = prepared[i]!;
          await authorizeStoredRequest(tx, row, true);
          const snapshot = await tx.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
          if ((snapshot?.page.id ?? null) !== row.page_id) throw new OperationError('page_identity_changed', 'The accepted page was deleted or recreated.', 'Read the page again and submit a new intent with a new request_id.');
          await assertUnboundPublication(tx, row, snapshot?.page.source_path);
          if ((snapshot?.revision ?? null) !== member.observedRevision) throw new OperationError('revision_conflict', 'The page changed during preparation.', 'Read its current revision and submit the updated intent with a new request_id.');
          await member.validate?.(tx);
          await setMemberAttribution(tx, requestAttribution(row));
          const outcome = await member.apply(tx);
          await classifyUnboundPage(tx, row);
          if (member.databaseOnlyReason === 'mirror_read_only') await classifyMirrorPage(tx, row);
          const final = await tx.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
          decoratePublicationOutcome(row, member, outcome, final, 0, false);
          await queuePublicationEffects(tx, row, final, outcome, member);
          outcomes.push(outcome);
        }
      }, requestAttribution(head));
      await lockCounters(tx, ['brain', ...new Set(rows.map(row => principalKey(requestPrincipal(row)))), `worktree:${head.worktree_id}`]);
      const current = await tx.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=ANY($1::uuid[]) ORDER BY sequence FOR UPDATE', [rows.map(row => row.id)]);
      const byId = new Map(current.map(row => [row.id, row]));
      const done: WriteRequest[] = [];
      for (let i = 0; i < rows.length; i++) {
        const locked = byId.get(rows[i]!.id);
        if (!locked || locked.execution_token !== rows[i]!.execution_token || locked.state !== 'running') throw new OperationError('write_claim_lost', 'Execution claim changed before publication.', 'Another worker holds the request; inspect it rather than resubmitting.');
        done.push(await completeWrite(tx, locked, 'committed', outcomes[i]!, undefined, locked));
      }
      return done;
    });
  } catch {
    return null;
  } finally {
    releaseCapacity?.();
    await lock.release();
  }
}

export interface GroupExecution {
  prepare(row: WriteRequest): Promise<PreparedMutation>;
  settled(row: WriteRequest): void;
  hostId: string;
}

/**
 * Prepares a claimed group (four members at a time), publishes it in one
 * transaction when every member qualifies, and otherwise publishes the
 * members one at a time in order. After a member ends in failure the later
 * members are cancelled, and after one is released back to the queue the
 * later ones are released too, so nothing overtakes it. Claims are renewed
 * for the whole group while it runs. Returns whether any member settled.
 */
export async function executeClaimedGroup(engine: BrainEngine, rows: WriteRequest[], run: GroupExecution): Promise<boolean> {
  let renewing: Promise<unknown> | undefined;
  const interval = setInterval(() => { renewing ??= renewGroupClaims(engine, rows).catch(() => undefined).finally(() => { renewing = undefined; }); }, 10_000);
  interval.unref?.();
  try {
    const prepared: Array<{ ok: PreparedMutation } | { error: unknown }> = new Array(rows.length);
    for (let start = 0; start < rows.length; start += 4) {
      await Promise.all(rows.slice(start, start + 4).map(async (row, offset) => {
        try { prepared[start + offset] = { ok: await run.prepare(row) }; } catch (error) { prepared[start + offset] = { error }; }
      }));
    }
    if (prepared.every(p => 'ok' in p)) {
      const done = await publishGroup(engine, rows, prepared.map(p => (p as { ok: PreparedMutation }).ok), run.hostId);
      if (done) { for (const row of done) run.settled(row); return true; }
    }
    let progressed = false, stop: 'cancel' | 'release' | null = null;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const current = await getWriteRequestById(engine, row.id);
      if (!current || current.execution_token !== row.execution_token || current.state !== 'running') {
        if (current && ['committed', 'conflict', 'failed', 'cancelled'].includes(current.state)) { run.settled(current); progressed = true; if (current.state !== 'committed') stop ??= 'cancel'; }
        continue;
      }
      if (stop === 'release') { await releaseUnpublishedClaim(engine, row, 'group_member_waiting'); continue; }
      if (stop === 'cancel') {
        const cancelled = await engine.transaction(tx => completeWrite(tx, current, 'cancelled', {}, { code: 'cancelled',
          message: 'An earlier page of the same bulk sync group failed; this page was not published and is re-frozen after that failure is resolved.' }));
        run.settled(cancelled); progressed = true; continue;
      }
      const p = prepared[i]!;
      const done = 'ok' in p ? await publishMutation(engine, row, p.ok, run.hostId) : await finishUnpublishedFailure(engine, current, p.error, 'preparation');
      run.settled(done);
      if (done.state === 'committed') { progressed = true; continue; }
      if (['conflict', 'failed', 'cancelled'].includes(done.state)) { progressed = true; stop = 'cancel'; } else stop = 'release';
    }
    return progressed;
  } finally {
    clearInterval(interval);
    await renewing;
  }
}
