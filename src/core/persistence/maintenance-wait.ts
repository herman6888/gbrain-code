/**
 * #5854: how long a maintenance publisher waits for its accepted write to
 * commit before the receipt reports `write_pending`. One budget per job:
 * every wait is `MAINTENANCE_WRITE_WAIT_MS`, capped by the job's remaining
 * deadline (no wait at or past it), and once one publish is still pending
 * after its wait the job's later publishes do not wait; they return
 * `write_pending` at once and are deferred like it. A pending write keeps its
 * request identity and commits later; it is never reported as committed.
 */
import { isTerminal, type WriteRequest } from './model.ts';

export const MAINTENANCE_WRITE_WAIT_MS = 30_000;

let testWaitMs: number | null = null;
/** Test seam: replace the 30 s base wait (null restores it). */
export function __setMaintenanceWriteWaitForTests(ms: number | null): void { testWaitMs = ms; }

export class MaintenanceWriteWait {
  private pending = false;
  constructor(private readonly deadlineAtMs: number | null = null, private readonly now: () => number = Date.now) {}

  /** The wait for the job's next publish. */
  ms(): number {
    if (this.pending) return 0;
    const base = testWaitMs ?? MAINTENANCE_WRITE_WAIT_MS;
    return this.deadlineAtMs == null ? base : Math.max(0, Math.min(base, this.deadlineAtMs - this.now()));
  }

  /** Record a publish after its wait; a row still pending stops the job's later waits. */
  observe(row: WriteRequest): WriteRequest {
    if (!isTerminal(row)) this.pending = true;
    return row;
  }
}
