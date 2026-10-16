import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import type { ParkedTarget } from '../../../core/persistence/effect-model.ts';
import type { WriteRequest } from '../../../core/persistence/model.ts';
import { OperationError } from '../../../core/ops/contract.ts';
import { authorizeStoredRequest } from '../../../core/persistence/authority.ts';

/** #6697: the stored authority's refusal message, or null while the original writer may still act. */
async function revokedAuthority(engine: BrainEngine, request: WriteRequest): Promise<string | null> {
  try {
    await authorizeStoredRequest(engine, request);
    return null;
  } catch (error) {
    if (error instanceof OperationError) return error.code === 'permission_denied' ? error.message : null;
    throw error;
  }
}

const SAMPLE = 20;

/**
 * #5612: Git and withdrawal targets that failed five consecutive times are
 * parked instead of retried forever. Reads the partial `persistence_effects_parked`
 * index: an exact count plus a capped sample naming each page and its retry command.
 */
export async function checkParkedEffects(engine: BrainEngine, sourceIds?: string[]): Promise<Check> {
  try {
    const scoped = sourceIds ? ' AND e.source_id=ANY($1::text[])' : '';
    const params = sourceIds ? [sourceIds] : [];
    const [{ count }] = await engine.executeRaw<{ count: number }>(`SELECT COUNT(*)::int AS count FROM persistence_effects e WHERE e.data ? 'parked'${scoped}`, params);
    const rows = await engine.executeRaw<{ request: WriteRequest; source_id: string; kind: string; state: string; parked: ParkedTarget[] }>(
      `SELECT to_jsonb(r) AS request,e.source_id,e.kind,e.state,e.data->'parked' AS parked FROM persistence_effects e
       JOIN persistence_requests r ON r.id=e.request_id WHERE e.data ? 'parked'${scoped} ORDER BY e.id LIMIT ${SAMPLE}`, params);
    const effects = [];
    for (const { request, ...row } of rows) {
      const preview = `gbrain sources writer retry-effects ${row.source_id} --request-id ${request.request_id} --dry-run`;
      const revoked = await revokedAuthority(engine, request);
      effects.push({ request_id: request.request_id, ...row, command: preview, ...(revoked === null ? {} : {
        owner_revoked: revoked,
        exit: row.kind === 'git'
          ? `the original writer is revoked; ask the user, then retry once under the brain owner's authority: gbrain sources writer retry-effects ${row.source_id} --request-id ${request.request_id} --admin-intent writer_retry_effects --expected-state <admin_state from gbrain sources writer status>`
          : 'the original writer is revoked and a withdrawal is never retried under another authority; ask the user how to withdraw the page' }) });
    }
    const details = { parked_effects: count, exact: true, inspected: rows.length, truncated: count > rows.length, effects };
    if (!count) return { name: 'parked_effects', status: 'ok', message: 'No Git or withdrawal effect is parked.', details };
    const listed = effects.map(effect => `${effect.kind} ${effect.source_id}: ${effect.parked.map(target =>
      `${target.slug ?? '(whole effect)'} (${target.error_code})`).join(', ')}; ${'exit' in effect ? effect.exit : effect.command}`);
    return { name: 'parked_effects', status: 'warn', details,
      message: `${count} Git or withdrawal effect(s) have parked targets after five consecutive failures; their withdrawal or Git backup is incomplete. ` +
        `Inspect \`gbrain sources writer status <source>\`, fix the cause, preview with the command shown, then rerun it without --dry-run to authorize one more attempt: ${listed.join(' | ')}` +
        (count > rows.length ? ` (first ${rows.length} of ${count} shown)` : '') +
        (effects.some(effect => effect.parked.some(target => target.error_code === 'git_target_pending'))
          ? '. git_target_pending: Git still lists a removed page file in the index; on Windows close the program holding it open (a sync watcher, indexer or antivirus), check with `git -c core.fscache=false status` on the brain host, then run the retry command.' : '') };
  } catch (error) {
    return { name: 'parked_effects', status: 'warn',
      message: `Parked effects could not be read: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { exact: false, inspected: 0, truncated: true, health: 'unknown' } };
  }
}
