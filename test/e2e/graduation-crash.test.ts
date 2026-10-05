/**
 * Engine graduation crash custody (PGLite -> Postgres 16).
 *
 * Protects: "exactly one authoritative engine at every instant, across
 * crashes" (plan §3.3, §6.2, §13). The real CLI run is SIGKILLed at every
 * custody boundary it announces (quiesce, drain, fence, mid-table and
 * table-boundary copy, verify, each cutover sub-step, around the routing flip)
 * and at every rollback substep. After each kill: no instant with two
 * writable engines; `--status` reports without mutating; a clean process with
 * no target environment variable resumes from the 0600 manifest; the end
 * state is graduated (or rolled back) with every expected.json expectation,
 * one row per request id, the queued request replaying its stored outcome,
 * and a green target doctor.
 * Regressions it catches: a step whose durable write is not ordered before
 * its effect (e.g. tombstone before rename, authority before tombstone),
 * reconciliation that restarts from routing instead of the manifest, a
 * resume that re-runs terminal requests, a rollback that strands the live
 * brain or restores authority after approval.
 * Not covered elsewhere: the orchestrator's unit tests run in-process without
 * kills. Production seam: `graduationBoundary()` hooks, inert unless the
 * crash preload registers them.
 * Runtime: about 40 s per case; run with GBRAIN_E2E_FILE_TIMEOUT=3600.
 */
import { afterAll, describe, expect } from 'bun:test';
import { rmSync } from 'node:fs';
import { GRADUATION_ROLLBACK_BOUNDARIES, GRADUATION_RUN_BOUNDARIES } from '../../src/core/persistence/engine-graduation.types.ts';
import { codeOf, DATABASE_URL, fixOf, gbrain, graduationTest, planHashOf, readEvents, startGbrain, stateOf, TARGET_ENV, waitForEvent } from '../helpers/graduation-e2e.ts';
import {
  authority, configuredEngine, expectAtMostOneWriter, expectGraduated, legacyCase, manifestState, planAndRun, rollback, scratchRoot,
  targetFenceTriggers, targetRowState, withSource, withTarget, type Case,
} from '../helpers/graduation-scenarios.ts';

const cases: Case[] = [];
afterAll(async () => {
  for (const c of cases) await c.target.close().catch(() => {});
  rmSync(scratchRoot, { recursive: true, force: true });
});

async function fresh(name: string): Promise<Case> {
  const c = await legacyCase(name);
  cases.push(c);
  return c;
}

/** Start the confirmed run paused at `pause`, wait for it, SIGKILL it. */
async function killAt(c: Case, pause: string, extra: string[] = []): Promise<void> {
  const { argv, env } = await planAndRun(c, { extra });
  const child = startGbrain(argv, { home: c.fx.home, env, hooks: { events: c.events, pause: [pause] }, timeoutMs: 600_000 });
  await waitForEvent(c.events, e => e.event === 'paused', child);
  child.kill('SIGKILL');
  const result = await child.exited;
  expect(result.signal).toBe('SIGKILL');
}

/** Graduate to completion with no kill. */
async function graduate(c: Case): Promise<void> {
  const { argv, env } = await planAndRun(c);
  const run = await gbrain(argv, { home: c.fx.home, env, timeoutMs: 900_000 });
  expect({ code: run.code, stderr: run.code === 0 ? '' : run.stderr.slice(-3000) }).toEqual({ code: 0, stderr: '' });
}

/** Start the rollback as an agent would (confirming with the hash if asked), paused at `boundary`, then SIGKILL it. */
async function killRollbackAt(c: Case, boundary: string): Promise<void> {
  const hooks = { events: c.events, pause: [boundary] };
  let child = startGbrain(['migrate', '--rollback-to-source', '--json'], { home: c.fx.home, hooks });
  const paused = await waitForEvent(c.events, e => e.event === 'paused', child).then(() => true, () => false);
  if (!paused) {
    const first = await child.exited;
    expect(first.code).toBe(3);
    child = startGbrain(['migrate', '--rollback-to-source', '--yes', '--expect', String(planHashOf(first.json)), '--json'], { home: c.fx.home, hooks });
    await waitForEvent(c.events, e => e.event === 'paused' && e.boundary === boundary, child);
  }
  child.kill('SIGKILL');
  await child.exited;
}

/** Every run boundary, with the copy boundaries pinned to a multi-batch table (pages at --batch-size 2). */
const RUN_KILLS: { pause: string; label: string }[] = GRADUATION_RUN_BOUNDARIES.map(b =>
  b === 'batch_copied' ? { pause: 'batch_copied@pages', label: 'mid-table (first committed batch of pages)' }
  : b === 'table_copied' ? { pause: 'table_copied@pages', label: 'table boundary (pages committed)' }
  : { pause: b, label: b });

describe.skipIf(!DATABASE_URL)('graduation: SIGKILL at every custody boundary', () => {
  for (const { pause, label } of RUN_KILLS) {
    graduationTest(`kill at ${label}: at most one writer, status read-only, clean-process resume graduates`, async () => {
      const c = await fresh(`kill-${pause.replace(/[@]/g, '-')}`);
      await killAt(c, pause, ['--batch-size', '2']);
      expect(readEvents(c.events).filter(e => e.event === 'boundary').at(-1)?.boundary).toBe(pause.split('@')[0]);
      await expectAtMostOneWriter(c, `after kill at ${pause}`);

      const status = await gbrain(['migrate', '--status', '--json'], { home: c.fx.home });
      expect(status.code).toBe(0);
      // `graduated` is announced after its own durable write, so a kill there already reads graduated.
      if (pause !== 'graduated') expect(stateOf(status.json)).not.toBe('graduated');

      // No target URL in the environment: resume reads the 0600 manifest's recorded identities.
      const resumed = await gbrain(['migrate', '--resume', '--json'], { home: c.fx.home, env: { [TARGET_ENV]: undefined }, timeoutMs: 900_000 });
      expect({ code: resumed.code, stderr: resumed.code === 0 ? '' : resumed.stderr.slice(-3000) }).toEqual({ code: 0, stderr: '' });
      await expectGraduated(c, `kill at ${pause}`);
    }, 900_000);
  }

  graduationTest('kill after authority, a target client writes before the routing flip, resume keeps the write and finishes routing', async () => {
    const c = await fresh('first-write-before-flip');
    await killAt(c, 'authoritative');
    expect(configuredEngine(c.fx).engine).toBe('pglite');
    const a = await authority(c);
    expect({ source: a.source, target: a.target }).toEqual({ source: false, target: true });
    // Another client already configured with the target URL (a second machine) writes first.
    const other = `${c.fx.dir}/other-client`;
    const put = await gbrain(['put', 'notes/first-post-cutover', '--source', 'default'],
      { home: other, env: { GBRAIN_DATABASE_URL: c.target.url }, stdin: '---\ntype: note\ntitle: First post-cutover write\n---\n\nWritten on the target before routing flipped.\n' });
    expect({ code: put.code, stderr: put.code === 0 ? '' : put.stderr.slice(-2000) }).toEqual({ code: 0, stderr: '' });
    const resumed = await gbrain(['migrate', '--resume', '--json'], { home: c.fx.home, timeoutMs: 600_000 });
    expect(resumed.code).toBe(0);
    expect(configuredEngine(c.fx).engine).toBe('postgres');
    await withTarget(c.target.url, async t => {
      const [page] = await t.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE source_id='default' AND slug='notes/first-post-cutover' AND deleted_at IS NULL`);
      expect(Number(page.n)).toBe(1);
    });
  }, 900_000);

  graduationTest('SIGKILL right after the first post-cutover write commits: the write survives, rollback lists it as user data', async () => {
    const c = await fresh('first-write-kill');
    await graduate(c);
    const writer = startGbrain(['put', 'notes/killed-after-commit', '--source', 'default'],
      { home: c.fx.home, stdin: '---\ntype: note\ntitle: Killed after commit\n---\n\nCommitted, then the writer died.\n' });
    const deadline = Date.now() + 120_000;
    for (;;) {
      const committed = await withTarget(c.target.url, t => t.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM persistence_requests
        WHERE slug='notes/killed-after-commit' AND state='committed'`));
      if (Number(committed[0].n) === 1) break;
      if (Date.now() > deadline) throw new Error('the post-cutover write never committed');
      await Bun.sleep(10);
    }
    writer.kill('SIGKILL');
    await writer.exited;
    const status = await gbrain(['migrate', '--status', '--json'], { home: c.fx.home });
    expect(stateOf(status.json)).toBe('graduated');
    const refused = await gbrain(['migrate', '--rollback-to-source', '--json'], { home: c.fx.home });
    expect(refused.code).toBe(3);
    expect(codeOf(refused.json)).toBe('graduation_rollback_writes_lost');
    expect(fixOf(refused.json)?.next).toBe('ask_user');
    expect(JSON.stringify(refused.json)).toContain('pages');
    // The refusal returned the target to authority; a normal client still writes.
    expect(await targetRowState(c.target.url)).toBe('authoritative');
    const put = await gbrain(['put', 'notes/after-refusal', '--source', 'default'], { home: c.fx.home, stdin: 'after refusal\n' });
    expect(put.code).toBe(0);
  }, 900_000);
});

describe.skipIf(!DATABASE_URL)('graduation: SIGKILL at every rollback substep', () => {
  for (const boundary of GRADUATION_ROLLBACK_BOUNDARIES) {
    graduationTest(`kill at ${boundary}: reconciliation ${boundary === 'rollback_fenced' ? 'restores target authority' : 'rolls forward to the source'}`, async () => {
      const c = await fresh(`rollback-${boundary}`);
      await graduate(c);
      await killRollbackAt(c, boundary);
      await expectAtMostOneWriter(c, `after kill at ${boundary}`);
      const status = await gbrain(['migrate', '--status', '--json'], { home: c.fx.home });
      expect(status.code).toBe(0);

      const resumed = await gbrain(['migrate', '--resume', '--json'], { home: c.fx.home, timeoutMs: 600_000 });
      expect({ code: resumed.code, stderr: resumed.code === 0 ? '' : resumed.stderr.slice(-3000) }).toEqual({ code: 0, stderr: '' });
      const a = await authority(c);
      if (boundary === 'rollback_fenced') {
        // Not yet approved: the live brain stays on the target.
        expect({ source: a.source, target: a.target }).toEqual({ source: false, target: true });
        expect(configuredEngine(c.fx).engine).toBe('postgres');
        const put = await gbrain(['put', 'notes/after-fenced-crash', '--source', 'default'], { home: c.fx.home, stdin: 'still live\n' });
        expect(put.code).toBe(0);
      } else {
        // Approved: never back to target authority; the source is live again.
        expect({ source: a.source, target: a.target }).toEqual({ source: true, target: false });
        expect(configuredEngine(c.fx).engine).toBe('pglite');
        expect(await targetFenceTriggers(c.target.url)).toBeGreaterThan(0);
        expect(manifestState(c.fx)).toBe('rolled_back');
        const put = await gbrain(['put', 'notes/after-rollback', '--source', 'default'], { home: c.fx.home, stdin: 'back on pglite\n' });
        expect(put.code).toBe(0);
        await withSource(c.fx, async source => {
          const [row] = await source.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE slug IN ('notes/queued-request','notes/after-rollback')`);
          expect(Number(row.n)).toBe(2);
        });
      }
    }, 900_000);
  }

  graduationTest('a target fact withdrawal or token revocation makes rollback refuse finally, even with --yes', async () => {
    const c = await fresh('rollback-security');
    await graduate(c);
    const revoke = await gbrain(['auth', 'revoke', 'legacy-fixture-live'], { home: c.fx.home });
    expect(revoke.code).toBe(0);
    const { first } = await rollback(c, { confirm: false });
    expect(first.code).toBe(1);
    expect(codeOf(first.json)).toBe('graduation_rollback_writes_lost');
    expect(fixOf(first.json)?.next).toBe('report');
    const forced = await gbrain(['migrate', '--rollback-to-source', '--yes', '--expect', 'any', '--json'], { home: c.fx.home });
    expect(forced.code).not.toBe(0);
    expect(await targetRowState(c.target.url)).toBe('authoritative');
    expect(await targetFenceTriggers(c.target.url)).toBe(0);
    expect(configuredEngine(c.fx).engine).toBe('postgres');
  }, 900_000);

  graduationTest('rollback with no post-cutover writes restores the source exactly and leaves the target fenced', async () => {
    const c = await fresh('rollback-clean');
    await graduate(c);
    const { first, confirmed } = await rollback(c);
    expect((confirmed ?? first).code).toBe(0);
    const a = await authority(c);
    expect({ source: a.source, target: a.target }).toEqual({ source: true, target: false });
    expect(await targetFenceTriggers(c.target.url)).toBeGreaterThan(0);
    const blocked = await withTarget(c.target.url, t => t.executeRaw(`INSERT INTO config(key,value) VALUES('graduation.stray','x')`).then(() => 'written', e => String(e)));
    expect(blocked).toContain('graduation');
  }, 900_000);
});

