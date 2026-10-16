/**
 * #6712 (L2 one page, one fate; #6565): how a managed sync run classifies a page request that ended without committing,
 * and whether an earlier invocation already stopped the run, so the settle path in sync-run.ts can route it: hold or
 * defer a page fault, re-freeze a transport fault in place, stop on a systemic one and re-freeze it on the next plain
 * sync when the fault table retries it.
 */
import type { BrainEngine } from '../engine.ts';
import type { WriteRequest } from './model.ts';
import { classifyTerminal } from './terminal-classify.ts';
import { classifySyncFault } from './sync-fault-class.ts';

/**
 * #6712 (#6565): how the run treats a receipt that did not commit, from the terminal classifier: `transport` (a dropped
 * connection, a retryable or unavailable refusal) re-freezes in place now; `page` is a fault of the one entry (held when
 * positively classified, else it blocks under the hold policy); `systemic` (the engine-graduation fence, an unknown
 * P0001, schema skew, any refusal it cannot place) stops the run blocked with the classifier's action.
 */
export function receiptClass(row: WriteRequest): 'transport' | 'page' | 'systemic' {
  if (row.recovery) return 'systemic';
  const kind = (row.intent as Record<string, unknown> | null)?.kind;
  const verdict = classifyTerminal({ request_id: row.request_id, source_id: row.source_id, slug: row.slug, operation: row.operation, state: row.state, error_code: row.error_code ?? null,
    error_detail: (row.error_detail ?? null) as object | null, recovery: row.recovery, blocked_reason: row.blocked_reason, compacted: row.compacted, publication_started: row.publication_started,
    intent_kind: typeof kind === 'string' ? kind : null, error_message: row.error_message ?? null });
  if (verdict?.category === 'transport' && verdict.code !== 'graduation_in_progress') return 'transport';
  return verdict?.class === 'page' ? 'page' : 'systemic';
}
/**
 * #6712 (#6565): a stop the next plain sync re-freezes in place: a database refusal the fault table retries (an
 * unrecognised P0001 or a 55000 raised under a page write surfaces as `storage_error`). A content, consent or option
 * refusal is never one: its receipt stays the diagnosis until --retry-failed.
 */
export function resumableStop(row: WriteRequest): boolean {
  const verdict = classifySyncFault({ code: row.error_code ?? 'storage_error', message: row.error_message ?? null });
  return verdict.class !== 'page' && verdict.safe_actions.includes('retry');
}
/**
 * #6712: whether an earlier invocation already stopped this run (its failure is recorded under the cursor key with the
 * run's id). An invocation records at most one stop and returns, so a recorded stop of the run is always an earlier one's,
 * and the pages its window admitted after the stop and the same refusal failed are re-frozen like the stop itself.
 */
export async function stopRecorded(engine: BrainEngine, key: string, runId: string): Promise<boolean> {
  return (await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='managed-sync-failure' AND fingerprint=$1 AND completed_keys->0->>'run_id'=$2", [key, runId])).length > 0;
}
