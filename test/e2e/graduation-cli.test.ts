/**
 * Engine graduation through the agent-operator CLI contract, on Postgres 16,
 * transaction-mode PgBouncer and a hosted-style non-superuser role.
 *
 * Protects: §3 measured outcomes and §7/§13 contract.
 * - Agent workflow: the bare command prints the plan and exits 3
 *   (`confirmation_required`, ask_user, egress + destructive effects,
 *   plan_hash, preview and fix commands); `--yes` alone re-plans and refuses;
 *   `--yes --expect <hash>` graduates with the doctor inline; the target
 *   doctor is green; existing tokens and OAuth clients authorize; over MCP a
 *   recall, a write, a replay of that write's request id (same outcome, no new
 *   row) and a grant-denied call behave as before.
 * - `--plan` and `--status` perform zero mutations, polled at every custody
 *   boundary and after a crash.
 * - `--force` binds the target's destructive snapshot: a page added between
 *   preview and confirmation refuses with `preview_changed`.
 * - The same legacy round trip through PgBouncer (DDL on the direct route) and
 *   as a NOSUPERUSER role (`disable_trigger` bypass recorded in the receipt).
 * - The 1k-page history fixture round trip with the plan-to-green-doctor
 *   clock under five minutes.
 * Not covered elsewhere: unit tests cover the plan document and the state
 * machine without a real target.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import postgres from '#postgres';
import { HISTORY_FIXTURE_TABLES } from '../../scripts/persistence/history-fixture.ts';
import {
  codeOf, custodyPaths, DATABASE_URL, digestChanges, fixOf, freePort, gbrain, graduationTest, graduationTestIf, hostedRoleTarget, mcpHttpCall, passwordLeaks, passwordOf,
  planHashOf, pooledUrl, release, startGbrain, stateDigest, TARGET_ENV, waitForEvent, type GbrainResult,
} from '../helpers/graduation-e2e.ts';
import {
  doctorFailures, expectGraduated, failingChecks, historyCase, legacyCase, planAndRun, scratchRoot, targetRowState, withSource, withTarget, type Case,
} from '../helpers/graduation-scenarios.ts';
import { canonicalRows, loadLegacyExpected } from '../fixtures/graduation/legacy-brain.ts';

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
  rmSync(scratchRoot, { recursive: true, force: true });
});
async function fresh(name: string, target?: Case['target']): Promise<Case> {
  const c = await legacyCase(name, target);
  cleanups.push(() => c.target.close());
  return c;
}

describe.skipIf(!DATABASE_URL)('graduation: agent workflow', () => {
  graduationTest('plan -> ask_user -> --yes --expect -> green doctor, then MCP recall, write, replay and a denied grant', async () => {
    const c = await fresh('agent-flow');
    const env = { [TARGET_ENV]: c.target.url };
    const results: GbrainResult[] = [];
    const started = Date.now();
    const ask = await gbrain(['migrate', '--to', 'postgres', '--url-env', TARGET_ENV, '--json'], { home: c.fx.home, env });
    results.push(ask);
    expect(ask.code).toBe(3);
    expect(codeOf(ask.json)).toBe('confirmation_required');
    expect(fixOf(ask.json)?.next).toBe('ask_user');
    expect(ask.json?.effects).toEqual(expect.arrayContaining(['egress', 'destructive']));
    const hash = planHashOf(ask.json)!;
    expect(hash).toMatch(/^[a-f0-9]{8,}$/);
    expect(JSON.stringify(fixOf(ask.json))).toContain(`--expect ${hash}`);
    expect(JSON.stringify(ask.json?.preview ?? ask.json)).toContain('--plan');
    expect(String(ask.json?.user_message ?? '')).toContain(new URL(c.target.url).hostname);
    expect(await targetRowState(c.target.url)).toBeNull();

    const yesOnly = await gbrain(['migrate', '--to', 'postgres', '--url-env', TARGET_ENV, '--yes', '--json'], { home: c.fx.home, env });
    results.push(yesOnly);
    expect(yesOnly.code).toBe(3);
    expect(planHashOf(yesOnly.json)).toBe(hash);

    const run = await gbrain(['migrate', '--to', 'postgres', '--url-env', TARGET_ENV, '--yes', '--expect', hash, '--json'], { home: c.fx.home, env, timeoutMs: 900_000 });
    results.push(run);
    expect({ code: run.code, stderr: run.code === 0 ? '' : run.stderr.slice(-3000) }).toEqual({ code: 0, stderr: '' });
    expect(failingChecks(run.json?.doctor ?? run.json?.receipt?.doctor ?? null)).toEqual([]);
    expect(JSON.stringify(run.json)).toContain('gbrain mcp expose');
    const minutes = (Date.now() - started) / 60_000;
    expect(minutes).toBeLessThan(5);
    await expectGraduated(c, 'agent flow');
    expect(passwordLeaks(passwordOf(c.target.url), results, c.fx.dir)).toEqual([]);

    const port = freePort();
    const serve = startGbrain(['serve', '--http', '--port', String(port)], { home: c.fx.home, timeoutMs: 300_000 });
    try {
      const base = `http://127.0.0.1:${port}`;
      const live = loadLegacyExpected().secrets.liveToken;
      for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/health`)).status < 500) break; } catch {} await Bun.sleep(100); }
      const t0 = performance.now();
      const recall = await mcpHttpCall(base, live, 'search', { query: 'acme' });
      const remoteMs = Math.round(performance.now() - t0);
      expect(recall.status).toBe(200);
      expect(JSON.stringify(recall.rpc)).toContain('acme');
      const requestId = '00000000-0000-4000-8000-0000000000e1';
      const write = await mcpHttpCall(base, live, 'put_page', { slug: 'notes/after-graduation', content: 'Written over MCP after graduation.\n', request_id: requestId });
      expect(write.rpc?.error).toBeUndefined();
      const replay = await mcpHttpCall(base, live, 'put_page', { slug: 'notes/after-graduation', content: 'Written over MCP after graduation.\n', request_id: requestId });
      expect(JSON.stringify(replay.rpc?.result)).toBe(JSON.stringify(write.rpc?.result));
      await withTarget(c.target.url, async t => {
        const [row] = await t.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
        expect(Number(row.n)).toBe(1);
      });
      const denied = await mcpHttpCall(base, loadLegacyExpected().secrets.revokedToken, 'search', { query: 'acme' });
      expect(denied.status === 401 || denied.status === 403 || !!denied.rpc?.error).toBe(true);
      console.log(JSON.stringify({ graduation_agent_flow: { minutes_plan_to_green_doctor: Number(minutes.toFixed(2)), remote_search_ms: remoteMs } }));
    } finally {
      serve.kill('SIGTERM');
      await serve.exited;
    }
  }, 1_200_000);
});

describe.skipIf(!DATABASE_URL)('graduation: --plan and --status are zero-mutation', () => {
  graduationTest('polled at every custody boundary and after a crash, neither changes a byte or a row', async () => {
    const c = await fresh('zero-mutation');
    const { argv, env } = await planAndRun(c);
    const child = startGbrain(argv, { home: c.fx.home, env, hooks: { events: c.events, pause: ['*'] } });
    const seen: string[] = [];
    const probe = async (label: string) => {
      const before = await stateDigest(c.fx.dir, c.target.url);
      const status = await gbrain(['migrate', '--status', '--json'], { home: c.fx.home });
      expect({ label, code: status.code }).toEqual({ label, code: 0 });
      await gbrain(['migrate', '--to', 'postgres', '--url-env', TARGET_ENV, '--plan', '--json'], { home: c.fx.home, env });
      // Not the poll's writes: the paused run's own kernel-lock heartbeat (.gbrain-lock/lock, every 30 s) and Bun's runtime install cache under the test HOME.
      const changes = digestChanges(before, await stateDigest(c.fx.dir, c.target.url))
        .filter(change => !change.includes('boundary-events.jsonl') && !change.includes('.gbrain-lock/lock') && !change.includes('/.bun/install/cache/'));
      expect({ label, changes }).toEqual({ label, changes: [] });
    };
    for (let ordinal = 1; ; ordinal++) {
      const paused = await waitForEvent(c.events, e => e.event === 'paused' && e.ordinal === ordinal, child).catch(() => null);
      if (!paused) break;
      seen.push(paused.boundary);
      await probe(`${paused.boundary}#${ordinal}`);
      if (paused.boundary === 'verified') {
        child.kill('SIGKILL');
        await child.exited;
        await probe('after a SIGKILL at verified');
        break;
      }
      release(c.events, ordinal);
    }
    expect(seen).toEqual(expect.arrayContaining(['quiesced', 'drained', 'target_fenced', 'table_copied', 'copied', 'verified']));
    expect((await gbrain(['migrate', '--resume', '--json'], { home: c.fx.home, timeoutMs: 900_000 })).code).toBe(0);
    await expectGraduated(c, 'after zero-mutation polling');
  }, 1_200_000);
});

describe.skipIf(!DATABASE_URL)('graduation: target emptiness and --force', () => {
  graduationTest('a target the user already initialised counts as empty', async () => {
    const c = await fresh('pre-initialised');
    const init = await gbrain(['doctor', '--json'], { home: join(c.fx.dir, 'init-home'), env: { GBRAIN_DATABASE_URL: c.target.url } });
    expect(init.code).not.toBe(2);
    const { argv, env } = await planAndRun(c);
    const run = await gbrain(argv, { home: c.fx.home, env, timeoutMs: 900_000 });
    expect({ code: run.code, stderr: run.code === 0 ? '' : run.stderr.slice(-3000) }).toEqual({ code: 0, stderr: '' });
    await expectGraduated(c, 'pre-initialised target');
  }, 900_000);

  graduationTest('a foreign non-empty target refuses; --force binds the wipe to the previewed snapshot', async () => {
    const c = await fresh('force');
    const other = join(c.fx.dir, 'foreign-home');
    const put = await gbrain(['put', 'notes/foreign', '--source', 'default'], { home: other, env: { GBRAIN_DATABASE_URL: c.target.url }, stdin: 'a foreign brain page\n' });
    expect(put.code).toBe(0);
    const env = { [TARGET_ENV]: c.target.url };
    const plain = await gbrain(['migrate', '--to', 'postgres', '--url-env', TARGET_ENV, '--plan', '--json'], { home: c.fx.home, env });
    expect(JSON.stringify(plain.json)).toContain('target_not_empty');
    const refused = await gbrain(['migrate', '--to', 'postgres', '--url-env', TARGET_ENV, '--yes', '--expect', String(planHashOf(plain.json)), '--json'], { home: c.fx.home, env });
    expect(codeOf(refused.json)).toBe('graduation_target_not_empty');
    expect(fixOf(refused.json)?.next).toBe('ask_user');

    const preview = await gbrain(['migrate', '--to', 'postgres', '--url-env', TARGET_ENV, '--force', '--plan', '--json'], { home: c.fx.home, env });
    expect(preview.code).toBe(0);
    const hash = planHashOf(preview.json)!;
    expect(JSON.stringify(preview.json)).toMatch(/pages/);
    const more = await gbrain(['put', 'notes/foreign-2', '--source', 'default'], { home: other, env: { GBRAIN_DATABASE_URL: c.target.url }, stdin: 'added after the preview\n' });
    expect(more.code).toBe(0);
    const before = await stateDigest(join(c.fx.dir, '.none'), c.target.url);
    const changed = await gbrain(['migrate', '--to', 'postgres', '--url-env', TARGET_ENV, '--force', '--yes', '--expect', hash, '--json'], { home: c.fx.home, env });
    expect(codeOf(changed.json)).toBe('preview_changed');
    expect(digestChanges(before, await stateDigest(join(c.fx.dir, '.none'), c.target.url))).toEqual([]);

    const again = await gbrain(['migrate', '--to', 'postgres', '--url-env', TARGET_ENV, '--force', '--plan', '--json'], { home: c.fx.home, env });
    const run = await gbrain(['migrate', '--to', 'postgres', '--url-env', TARGET_ENV, '--force', '--yes', '--expect', String(planHashOf(again.json)), '--json'],
      { home: c.fx.home, env, timeoutMs: 900_000 });
    expect({ code: run.code, stderr: run.code === 0 ? '' : run.stderr.slice(-3000) }).toEqual({ code: 0, stderr: '' });
    await expectGraduated(c, 'after --force');
    await withTarget(c.target.url, async t => {
      const [row] = await t.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE slug LIKE 'notes/foreign%'`);
      expect(Number(row.n)).toBe(0);
    });
  }, 900_000);
});

describe.skipIf(!DATABASE_URL)('graduation: connection topologies', () => {
  graduationTestIf(!process.env.GBRAIN_PGBOUNCER_URL)('through transaction-mode PgBouncer with DDL on the direct route', async () => {
    const c = await fresh('pgbouncer');
    const pooled = pooledUrl(c.target)!;
    const { argv, env } = await planAndRun(c, { url: pooled, env: { GBRAIN_DIRECT_DATABASE_URL: c.target.url } });
    const run = await gbrain(argv, { home: c.fx.home, env, timeoutMs: 900_000 });
    expect({ code: run.code, stderr: run.code === 0 ? '' : run.stderr.slice(-3000) }).toEqual({ code: 0, stderr: '' });
    await expectGraduated(c, 'pgbouncer');
  }, 900_000);

  test('the hosted-style role is a real constraint: no session_replication_role, but it owns what it creates', async () => {
    const hosted = await hostedRoleTarget();
    cleanups.push(() => hosted.close());
    const sql = postgres(hosted.url, { max: 1, prepare: false, onnotice: () => {} });
    try {
      const replica = await sql.begin(tx => tx.unsafe('SET LOCAL session_replication_role = replica')).then(() => 'allowed', e => String((e as { code?: string }).code));
      expect(replica).toBe('42501');
      await sql.unsafe('CREATE TABLE probe(id int primary key); ALTER TABLE probe DISABLE TRIGGER USER; DROP TABLE probe');
      const [ext] = await sql.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM pg_extension WHERE extname='vector'`);
      expect(Number(ext.n)).toBe(1);
    } finally { await sql.end(); }
    const oldUrl = hosted.url;
    const rotated = await hosted.rotatePassword();
    expect(passwordOf(rotated)).not.toBe(passwordOf(oldUrl));
    const stale = postgres(oldUrl, { max: 1, prepare: false, onnotice: () => {}, connect_timeout: 5 });
    expect(await stale.unsafe('SELECT 1').then(() => 'connected', e => String((e as { code?: string }).code))).toBe('28P01');
    await stale.end();
    const fresh = postgres(rotated, { max: 1, prepare: false, onnotice: () => {} });
    expect((await fresh.unsafe<{ n: number }[]>('SELECT 1 AS n'))[0].n).toBe(1);
    await fresh.end();
  });

  graduationTest('as a hosted-style NOSUPERUSER role: the disable-trigger fallback, every user trigger re-enabled', async () => {
    const hosted = await hostedRoleTarget();
    const c = await fresh('hosted-role', hosted);
    const { argv, env } = await planAndRun(c, { url: hosted.url });
    const run = await gbrain(argv, { home: c.fx.home, env, timeoutMs: 900_000 });
    expect({ code: run.code, stderr: run.code === 0 ? '' : run.stderr.slice(-3000) }).toEqual({ code: 0, stderr: '' });
    expect(JSON.stringify(run.json)).toContain('disable_trigger');
    await expectGraduated(c, 'hosted role');
    const sql = postgres(hosted.url, { max: 1, prepare: false, onnotice: () => {} });
    try {
      const disabled = await sql.unsafe<{ t: string }[]>(`SELECT c.relname || '.' || t.tgname AS t FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal AND t.tgenabled <> 'O'`);
      expect(disabled.map(r => r.t)).toEqual([]);
    } finally { await sql.end(); }
  }, 900_000);

  graduationTest('--trigger-bypass disable-trigger is honoured on a superuser target and recorded', async () => {
    const c = await fresh('forced-bypass');
    const { argv, env } = await planAndRun(c, { extra: ['--trigger-bypass', 'disable-trigger'] });
    const run = await gbrain(argv, { home: c.fx.home, env, timeoutMs: 900_000 });
    expect(run.code).toBe(0);
    expect(JSON.stringify(run.json)).toContain('disable_trigger');
    await expectGraduated(c, 'forced disable-trigger');
  }, 900_000);
});

describe.skipIf(!DATABASE_URL)('graduation: 1k-page history round trip', () => {
  graduationTest('1,000 pages with history graduate with verify green and the plan-to-green-doctor clock under five minutes', async () => {
    const { fx, target } = await historyCase('history-1k', 1000);
    cleanups.push(() => target.close());
    const env = { [TARGET_ENV]: target.url };
    const t0 = Date.now();
    const plan = await gbrain(['migrate', '--to', 'postgres', '--url-env', TARGET_ENV, '--json'], { home: fx.home, env });
    expect(plan.code).toBe(3);
    const run = await gbrain(['migrate', '--to', 'postgres', '--url-env', TARGET_ENV, '--yes', '--expect', String(planHashOf(plan.json)), '--json'],
      { home: fx.home, env, timeoutMs: 1_800_000 });
    expect({ code: run.code, stderr: run.code === 0 ? '' : run.stderr.slice(-3000) }).toEqual({ code: 0, stderr: '' });
    const doctor = await doctorFailures(fx.home);
    const wallMs = Date.now() - t0;
    expect(doctor.failing).toEqual([]);
    console.log(JSON.stringify({ graduation_1k: { wall_ms: wallMs, fixture: fx.report, timings: run.json?.receipt?.timings ?? run.json?.timings ?? null } }));
    expect(wallMs).toBeLessThan(5 * 60_000);

    const retained = custodyPaths(fx.dataDir).graduated[0];
    const outputs = fx.outputs as { queuedRequestId: string; delayedEffectId: string };
    const sourceSide = await withSource(fx, async source => {
      const counts: Record<string, number> = {};
      for (const table of HISTORY_FIXTURE_TABLES) counts[table] = Number((await source.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`))[0].n);
      const rows: Record<string, string[]> = {};
      for (const table of ['pages', 'page_versions', 'facts', 'takes', 'fact_withdrawals', 'content_chunks', 'access_tokens', 'oauth_clients', 'oauth_tokens']) rows[table] = await canonicalRows(source, table);
      return { counts, rows };
    }, retained);
    await withTarget(target.url, async t => {
      for (const table of HISTORY_FIXTURE_TABLES) {
        const n = Number((await t.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`))[0].n);
        expect({ table, n }).toEqual({ table, n: sourceSide.counts[table] });
      }
      for (const [table, rows] of Object.entries(sourceSide.rows)) {
        const got = await canonicalRows(t, table);
        const first = got.findIndex((row, i) => row !== rows[i]);
        expect({ table, length: got.length, first }).toEqual({ table, length: rows.length, first: -1 });
      }
      const [queued] = await t.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [outputs.queuedRequestId]);
      expect(queued.state).toBe('committed');
      const [delayed] = await t.executeRaw<{ state: string }>('SELECT state FROM persistence_effects WHERE id=$1', [outputs.delayedEffectId]);
      expect(delayed.state).toBe('queued');
    });
  }, 1_800_000);
});

