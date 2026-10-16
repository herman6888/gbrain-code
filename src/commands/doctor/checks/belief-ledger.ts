/**
 * W1 `belief_ledger_coverage` (docs/designs/BELIEF_LEDGER.md section 7.3):
 * per covered source, its coverage intervals with certified status, watermark
 * and baseline progress; drift (slugs whose current belief set no longer
 * hashes to their newest event's state_hash), sampled by default and complete
 * under `--tier deep`; orphan lifetimes; committed publications with no commit
 * mark; and a restore whose purge replay was unavailable, partial or
 * unverified.
 *
 * `--fix` appends `reconcile` events for the drifted slugs (a managed source's
 * slug interval stays uncertified) and fills the missing commit marks, then
 * reports what is left. Without `--fix` the reconcile is the `run` fix; a
 * restore finding asks the user (the purge replay needs the original brain);
 * a brain with no coverage is information, with enabling as an `ask_user` fix.
 */
import type { Check } from '../../doctor.ts';
import { agentFix, checkError, doctorVerify, infoCheck } from '../check-fix.ts';
import { connectedEngine, doctorSourceIds, type DoctorContext, type DoctorEntry } from '../context.ts';
import {
  DRIFT_SAMPLE_PAGES, coverageIntervals, coveredSources, fillCommitMarks, orphanLifetimes, reconcileBeliefDrift, scanBeliefDrift, unmarkedPublications,
} from '../../../core/belief/coverage-report.ts';

const DOCS = 'docs/designs/BELIEF_LEDGER.md#73-the-doctor-coverage-check';
const UNSAFE_REPLAY = new Set(['unavailable', 'partial', 'unverified']);

async function runBeliefLedger(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const engine = connectedEngine(ctx);
    const scope = doctorSourceIds(ctx);
    const sources = (await coveredSources(engine)).filter(id => !scope || scope.includes(id));
    if (!sources.length) {
      checks.push(infoCheck('belief_ledger_coverage', 'The belief ledger is off: no source records what this brain had recorded, and when.', 'disabled_by_choice',
        { argv: ['gbrain', 'beliefs', 'enable', '--source', scope?.[0] ?? 'default'], consent: [], actor: 'agent', ask_user: true, requires_exclusive: false, docs: DOCS,
          why: 'Enabling baselines every page of the source and records each later change; only a managed source is certified.',
          user_message: 'Do you want gbrain to keep a belief ledger (a recorded history of facts, takes and links) for this source?',
          verify: doctorVerify('belief_ledger_coverage') }));
      return checks;
    }
    const deep = ctx.tier === 'deep';
    const perSource = [];
    for (const sourceId of sources) {
      if (ctx.doFix && !ctx.dryRun) {
        await reconcileBeliefDrift(engine, sourceId, deep ? { op: 'doctor_fix' } : { op: 'doctor_fix', limit: DRIFT_SAMPLE_PAGES });
        await fillCommitMarks(engine, sourceId, { deep });
      }
      const intervals = await coverageIntervals(engine, sourceId);
      const drift = await scanBeliefDrift(engine, sourceId, { deep });
      const open = intervals.at(-1)!;
      perSource.push({ source_id: sourceId, recording: !open.stopped_at, certified: open.certified, watermark: open.watermark, baseline: open.baseline,
        intervals: intervals.length, drift: { checked: drift.checked, candidates: drift.candidates, exact: drift.exact, slugs: drift.drifted.slice(0, 10).map(d => d.slug), count: drift.drifted.length },
        drift_marks: open.drift.length, orphans: await orphanLifetimes(engine, sourceId, 5, { deep }), unmarked: (await unmarkedPublications(engine, sourceId, 1000, { deep })).length,
        restores: open.restores.filter(r => r.purge_replay && UNSAFE_REPLAY.has(r.purge_replay)) });
    }
    const details = { sources: perSource, deep, docs: DOCS };
    const restore = perSource.find(s => s.restores.length);
    if (restore) {
      const r = restore.restores.at(-1)!;
      const unreplayed = r.replays.filter(x => x.outcome !== 'complete').map(x => x.request_id);
      checks.push({ name: 'belief_ledger_coverage', status: 'warn', details,
        message: `A backup restore of ${restore.source_id} at ${r.at} could not replay every purge made after the archive (${r.archived_at ?? 'unknown time'}): purge replay ${r.purge_replay}`
          + `${unreplayed.length ? ` for ${unreplayed.join(', ')}` : ''}. Content purged after the backup may be readable again.`,
        fix: { argv: ['gbrain', 'beliefs', 'status', '--source', restore.source_id, '--json'], consent: [], actor: 'user', ask_user: true, requires_exclusive: false, docs: DOCS,
          why: 'The replay reads the purge events of the original brain; only the user can say where it is, or whether to run those purges again.',
          user_message: `Your restored brain may contain content you purged after the backup was made (${restore.source_id}). Do you have the original brain available so the purges can be replayed, or should they be run again?`,
          verify: doctorVerify('belief_ledger_coverage') } });
      return checks;
    }
    const drifted = perSource.filter(s => s.drift.count || s.orphans.count || s.unmarked);
    if (drifted.length) {
      const first = drifted[0]!;
      checks.push({ name: 'belief_ledger_coverage', status: 'warn', details,
        message: drifted.map(s => `${s.source_id}: ${s.drift.count}${s.drift.exact ? '' : '+'} drifted slug(s)${s.drift.count ? ` (e.g. ${s.drift.slugs.slice(0, 3).join(', ')})` : ''}, `
          + `${s.orphans.count} orphan lifetime(s), ${s.unmarked} publication(s) without a commit mark`).join('; ')
          + '. A writer changed beliefs without appending; reconcile appends reconcile events and the drifted interval stays uncertified on a managed source.',
        fix: agentFix(['gbrain', 'beliefs', 'reconcile', '--source', first.source_id, '--json'],
          'Appends reconcile events (origin reconcile, honest recorded time) for the drifted slugs and fills missing commit marks; it changes no belief.', 'belief_ledger_coverage', { docs: DOCS }) });
      return checks;
    }
    const pending = perSource.find(s => s.recording && !s.baseline.complete);
    if (pending) {
      checks.push({ name: 'belief_ledger_coverage', status: 'warn', details,
        message: `The belief ledger baseline of ${pending.source_id} is incomplete (${pending.baseline.pages_done} page(s) done, ${pending.baseline.pending ?? '?'} pending), so it has no watermark yet.`,
        fix: agentFix(['gbrain', 'beliefs', 'enable', '--source', pending.source_id, '--json'], 'Resumes the interrupted baseline; pages already baselined are skipped.',
          'belief_ledger_coverage', { docs: DOCS }) });
      return checks;
    }
    checks.push({ name: 'belief_ledger_coverage', status: 'ok', details,
      message: perSource.map(s => `${s.source_id}: ${s.recording ? `recording since ${s.watermark}` : 'stopped'}, ${s.certified ? 'certified (links: journaled publications only)' : 'uncertified'}`
        + `${s.drift_marks ? `, ${s.drift_marks} drift mark(s)` : ''}; no drift in ${s.drift.checked} slug(s)${s.drift.exact ? '' : ` of ${s.drift.candidates} (sampled; --tier deep checks all)`}`).join('; ') + '.' });
  } catch (error) {
    checks.push(checkError('belief_ledger_coverage', 'check the belief ledger coverage', error, { details: { docs: DOCS } }));
  }
  return checks;
}

export const beliefLedgerEntry: DoctorEntry = { name: 'belief_ledger_coverage', emits: ['belief_ledger_coverage'], run: runBeliefLedger };
