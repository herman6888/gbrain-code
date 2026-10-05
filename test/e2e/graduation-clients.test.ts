/**
 * Engine graduation versus every other client of the brain: older released
 * binaries, a `gbrain serve` respawned mid-copy, a resident serve that must
 * hand the source over, and stale CLI or MCP configurations after cutover.
 *
 * Protects: §3.3 and §6.4 of the plan plus §13 CEO/DX (tombstone, marker
 * hand-off, split-brain detection, database fence, one-step stale-client fix).
 * - An older release pointed at the tombstoned path fails (EEXIST/ENOTDIR)
 *   and never creates a fresh empty brain there. This half runs before the
 *   orchestrator lands, against a tombstone written to the Tombstone contract.
 * - In the rename-to-tombstone window an older release can create a stray
 *   brain; the next `--resume` refuses with `graduation_split_brain` and the
 *   target stays non-authoritative.
 * - A write by an older release in a lock gap before the tombstone reaches
 *   the target on resume (source digests re-checked).
 * - An older release configured with the target URL cannot write while the
 *   target is fenced (copying, and between verify and cutover).
 * - A respawned stdio or HTTP serve exits with `graduation_in_progress`,
 *   writes nothing and takes no lock; a resident serve hands off within 30 s.
 * - A stale CLI config and a stale MCP config each recover by running the
 *   refusal's fix once.
 * Not covered elsewhere: these are the only multi-process client tests.
 * Older binaries are built once per tag (test/helpers/graduation-e2e.ts
 * `olderReleaseBinary`, cached under GBRAIN_OLDER_RELEASE_DIR).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync, constants } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Tombstone } from '../../src/core/persistence/engine-graduation.types.ts';
import {
  codeOf, custodyPaths, leakNeedle, passwordOf, DATABASE_URL, digestChanges, fixOf, freePort, gbrain, graduationTest, mcpStdioSession, olderReleaseBinary,
  previousReleaseTags, release, REPO, startGbrain, stateDigest, TARGET_ENV, waitForEvent, type GbrainResult,
} from '../helpers/graduation-e2e.ts';
import { configuredEngine, expectGraduated, legacyCase, planAndRun, scratchRoot, targetRowState, withTarget, type Case } from '../helpers/graduation-scenarios.ts';

const cases: Case[] = [];
let older: { tag: string; binary: string }[] = [];
let olderError: string | null = null;

beforeAll(() => {
  try { older = previousReleaseTags(2).map(tag => ({ tag, binary: olderReleaseBinary(tag) })); }
  catch (error) { olderError = String(error); }
}, 900_000);

afterAll(async () => {
  for (const c of cases) await c.target.close().catch(() => {});
  rmSync(scratchRoot, { recursive: true, force: true });
});

async function fresh(name: string): Promise<Case> {
  const c = await legacyCase(name);
  cases.push(c);
  return c;
}

/** A second GBRAIN_HOME whose copied config still routes to the PGLite path (a stale client on this machine). */
function staleHome(c: Case): string {
  const home = join(c.fx.dir, 'stale-home');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: c.fx.dataDir, embedding_disabled: true }, null, 2), { mode: 0o600 });
  return home;
}

/** `gbrain` on PATH for running a refusal's shell `fix.command` exactly as an agent would. */
function shimPath(c: Case): string {
  const bin = join(c.fx.dir, 'shim-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gbrain'), `#!/bin/sh\nexec "${process.execPath}" --no-env-file "${join(REPO, 'src', 'cli.ts')}" "$@"\n`);
  chmodSync(join(bin, 'gbrain'), 0o755);
  return `${bin}:${process.env.PATH}`;
}

/** Run a refusal's fix once: `fix.argv` through the CLI, or the shell `fix.command`. */
/** The first rendered fix (`next` run or tell_user_to_run) anywhere in an MCP reply, including JSON-encoded text content. */
function findFix(value: unknown): Record<string, any> | null {
  if (typeof value === 'string') { try { return findFix(JSON.parse(value)); } catch { return null; } }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, any>;
  if ((record.next === 'run' || record.next === 'tell_user_to_run') && Array.isArray(record.argv)) return record;
  for (const child of Object.values(record)) { const found = findFix(child); if (found) return found; }
  return null;
}

async function runFix(fix: Record<string, any>, home: string, c: Case): Promise<GbrainResult> {
  const env = { [TARGET_ENV]: c.target.url, PATH: shimPath(c) };
  // An agent fills `<name>` argv placeholders from fix.inputs (the user supplies the target URL).
  const filled = Array.isArray(fix.argv) ? (fix.argv as string[]).map(a => a === '<target_url>' ? c.target.url : a) : null;
  if (filled && filled[0] === 'gbrain') return gbrain(filled.slice(1), { home, env });
  expect(typeof fix.command).toBe('string');
  const child = Bun.spawn(['sh', '-c', fix.command], { env: { ...process.env, ...env, HOME: home, GBRAIN_HOME: home, DATABASE_URL: '', GBRAIN_DATABASE_URL: '' }, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await child.exited;
  return { code: child.exitCode ?? -1, signal: null, stdout, stderr, json: null, ms: 0 };
}

/** The Tombstone contract written by hand (O_EXCL, 0600, fsync file + parent), for the pre-integration half. */

async function olderRun(binary: string, home: string, argv: string[], stdin?: string): Promise<GbrainResult> {
  return gbrain(argv, { home, binary, stdin, timeoutMs: 120_000 });
}

describe.skipIf(!DATABASE_URL)('graduation: older released binaries', () => {
  test('older releases refuse a tombstoned path and never create a data dir there', async () => {
    expect(olderError).toBeNull();
    expect(older.length).toBe(2);
    const c = await fresh('older-tombstone');
    const { argv, env } = await planAndRun(c);
    expect((await gbrain(argv, { home: c.fx.home, env, timeoutMs: 900_000 })).code).toBe(0);
    const home = staleHome(c);
    const tombstoneBytes = readFileSync(c.fx.dataDir);
    const retained = custodyPaths(c.fx.dataDir).graduated;
    expect(retained.length).toBe(1);
    const retainedBefore = await stateDigest(retained[0]);
    for (const { tag, binary } of older) {
      for (const [argv, stdin] of [[['query', 'acme'], undefined], [['put', 'notes/older-write', '--source', 'default'], 'older binary write\n']] as const) {
        const r = await olderRun(binary, home, [...argv], stdin);
        expect({ tag, argv: argv[0], failed: r.code !== 0 }).toEqual({ tag, argv: argv[0], failed: true });
        expect(`${r.stdout}${r.stderr}`).toMatch(/EEXIST|ENOTDIR|engine_graduated/);
        expect(statSync(c.fx.dataDir).isFile()).toBe(true);
        expect(readFileSync(c.fx.dataDir).equals(tombstoneBytes)).toBe(true);
      }
    }
    expect(digestChanges(retainedBefore, await stateDigest(retained[0]))).toEqual([]);
  }, 900_000);

  graduationTest('an older release in the rename-to-tombstone window: a stray brain is reported as split brain and the target stays withheld', async () => {
    const c = await fresh('older-window');
    const { argv, env } = await planAndRun(c);
    const child = startGbrain(argv, { home: c.fx.home, env, hooks: { events: c.events, pause: ['moved_aside'] } });
    await waitForEvent(c.events, e => e.event === 'paused', child);
    child.kill('SIGKILL');
    await child.exited;
    const home = staleHome(c);
    const stray = await olderRun(older[0].binary, home, ['put', 'notes/stray', '--source', 'default'], 'stray brain write\n');
    const createdStray = custodyPaths(c.fx.dataDir).dataDirIsDirectory;
    const resumed = await gbrain(['migrate', '--resume', '--json'], { home: c.fx.home, timeoutMs: 600_000 });
    if (createdStray) {
      expect(resumed.code).toBe(1);
      expect(codeOf(resumed.json)).toBe('graduation_split_brain');
      expect(fixOf(resumed.json)?.next).toBe('ask_user');
      expect(await targetRowState(c.target.url)).not.toBe('authoritative');
      const status = await gbrain(['migrate', '--status', '--json'], { home: c.fx.home });
      const text = JSON.stringify(status.json);
      expect(text).toContain(c.fx.dataDir);
      expect(text).toContain('.graduated-');
    } else {
      expect(stray.code).not.toBe(0);
      expect(resumed.code).toBe(0);
      await expectGraduated(c, 'window without a stray brain');
    }
  }, 900_000);

  graduationTest('an older release after the tombstone fails EEXIST; resume completes', async () => {
    const c = await fresh('older-after-tombstone');
    const { argv, env } = await planAndRun(c);
    const child = startGbrain(argv, { home: c.fx.home, env, hooks: { events: c.events, pause: ['tombstoned'] } });
    await waitForEvent(c.events, e => e.event === 'paused', child);
    child.kill('SIGKILL');
    await child.exited;
    for (const { binary } of older) {
      const r = await olderRun(binary, staleHome(c), ['query', 'acme']);
      expect(r.code).not.toBe(0);
      expect(statSync(c.fx.dataDir).isFile()).toBe(true);
    }
    expect((await gbrain(['migrate', '--resume', '--json'], { home: c.fx.home, timeoutMs: 600_000 })).code).toBe(0);
    await expectGraduated(c, 'after tombstone kill');
  }, 900_000);

  for (const boundary of ['verified', 'source_closed'] as const) {
    graduationTest(`an older-release write to the source in the lock gap after ${boundary} reaches the target on resume`, async () => {
      const c = await fresh(`older-gap-${boundary}`);
      const { argv, env } = await planAndRun(c);
      const child = startGbrain(argv, { home: c.fx.home, env, hooks: { events: c.events, pause: [boundary] } });
      await waitForEvent(c.events, e => e.event === 'paused', child);
      child.kill('SIGKILL');
      await child.exited;
      const aware = await gbrain(['put', 'notes/lock-gap-aware', '--source', 'default', '--json'], { home: c.fx.home, stdin: 'a graduation-aware binary must not write here\n', timeoutMs: 120_000 });
      if (boundary === 'source_closed') {
        expect({ code: aware.code, error: codeOf(aware.json) }).toEqual({ code: 1, error: 'graduation_interrupted' });
      }
      const write = await olderRun(older[0].binary, c.fx.home, ['put', 'notes/lock-gap-write', '--source', 'default'], 'written by an older release in the lock gap\n');
      expect({ code: write.code, stderr: write.code === 0 ? '' : write.stderr.slice(-1500) }).toEqual({ code: 0, stderr: '' });
      const resumed = await gbrain(['migrate', '--resume', '--json'], { home: c.fx.home, timeoutMs: 900_000 });
      expect({ code: resumed.code, stderr: resumed.code === 0 ? '' : resumed.stderr.slice(-3000) }).toEqual({ code: 0, stderr: '' });
      await withTarget(c.target.url, async t => {
        const [row] = await t.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE source_id='default' AND slug='notes/lock-gap-write'`);
        expect(Number(row.n)).toBe(1);
      });
      expect(configuredEngine(c.fx).engine).toBe('postgres');
    }, 900_000);
  }

  graduationTest('an older release configured with the target URL cannot write while the target is fenced', async () => {
    const c = await fresh('older-vs-fence');
    const { argv, env } = await planAndRun(c, { extra: ['--batch-size', '2'] });
    const child = startGbrain(argv, { home: c.fx.home, env, hooks: { events: c.events, pause: ['batch_copied@pages', 'verified'] } });
    for (const ordinal of [1, 2]) {
      const paused = await waitForEvent(c.events, e => e.event === 'paused' && e.ordinal === ordinal, child);
      const before = await stateDigest(join(c.fx.dir, 'nonexistent'), c.target.url);
      const probeHome = join(c.fx.dir, `older-target-${ordinal}`);
      const r = await olderRun(older[0].binary, probeHome, ['put', 'notes/fenced', '--source', 'default'], 'must not land\n');
      expect({ boundary: paused.boundary, failed: r.code !== 0 }).toEqual({ boundary: paused.boundary, failed: true });
      expect(digestChanges(before, await stateDigest(join(c.fx.dir, 'nonexistent'), c.target.url))).toEqual([]);
      release(c.events, ordinal);
    }
    const done = await child.exited;
    expect(done.code).toBe(0);
    await expectGraduated(c, 'after fenced probes');
  }, 900_000);
});

describe.skipIf(!DATABASE_URL)('graduation: serve processes', () => {
  graduationTest('a serve respawned mid-copy (stdio and http) exits with graduation_in_progress, writes nothing, takes no lock', async () => {
    const c = await fresh('respawn-serve');
    const { argv, env } = await planAndRun(c, { extra: ['--batch-size', '2'] });
    const child = startGbrain(argv, { home: c.fx.home, env, hooks: { events: c.events, pause: ['batch_copied@pages'] } });
    const paused = await waitForEvent(c.events, e => e.event === 'paused', child);
    const watched = async () => {
      const d = await stateDigest(c.fx.dataDir, c.target.url);
      for (const path of [`${c.fx.dataDir}.gbrain-graduation.json`, join(c.fx.home, '.gbrain', 'graduation-manifest.json'), join(c.fx.home, '.gbrain', 'config.json')]) {
        d.files[path] = existsSync(path) ? readFileSync(path, 'utf8') : '(absent)';
      }
      return d;
    };
    const before = await watched();
    const stdio = await mcpStdioSession({ home: c.fx.home, timeoutMs: 60_000 });
    const stdioExit = await Promise.race([stdio.exited, Bun.sleep(45_000).then(() => null)]);
    expect(stdioExit).not.toBeNull();
    expect(stdioExit!.code).not.toBe(0);
    expect(`${stdioExit!.stdout}${stdioExit!.stderr}`).toContain('graduation_in_progress');
    const http = await gbrain(['serve', '--http', '--port', String(freePort())], { home: c.fx.home, timeoutMs: 60_000 });
    expect(http.code).not.toBe(0);
    expect(http.signal).toBeNull();
    expect(`${http.stdout}${http.stderr}`).toContain('graduation_in_progress');
    expect(digestChanges(before, await watched())).toEqual([]);
    release(c.events, paused.ordinal!);
    const done = await child.exited;
    expect({ code: done.code, stderr: done.code === 0 ? '' : done.stderr.slice(-3000) }).toEqual({ code: 0, stderr: '' });
    await expectGraduated(c, 'after respawned serves');
  }, 900_000);

  graduationTest('a resident stdio serve hands the source over through the intent marker; no manual stop', async () => {
    const c = await fresh('live-serve');
    const serve = await mcpStdioSession({ home: c.fx.home, timeoutMs: 900_000 });
    const before = await serve.call('get_page', { slug: 'people/alice-example', source_id: 'default' });
    expect(before?.error).toBeUndefined();
    const { argv, env } = await planAndRun(c);
    const run = await gbrain(argv, { home: c.fx.home, env, timeoutMs: 900_000 });
    expect({ code: run.code, stderr: run.code === 0 ? '' : run.stderr.slice(-3000) }).toEqual({ code: 0, stderr: '' });
    const served = await Promise.race([serve.exited, Bun.sleep(30_000).then(() => null)]);
    expect(served).not.toBeNull();
    expect(`${served!.stdout}${served!.stderr}`).toContain('graduation_in_progress');
    expect(JSON.stringify(run.json)).toMatch(/restart|mcp/i);
    await expectGraduated(c, 'after live-serve hand-off', { liveWork: true });
    const relaunched = await mcpStdioSession({ home: c.fx.home });
    const after = await relaunched.call('get_page', { slug: 'people/alice-example', source_id: 'default' });
    await relaunched.close();
    expect(after?.error).toBeUndefined();
  }, 900_000);
});

describe.skipIf(!DATABASE_URL)('graduation: stale clients recover in one step', () => {
  graduationTest('a stale CLI config gets engine_graduated with a fix that works when run once', async () => {
    const c = await fresh('stale-cli');
    const { argv, env } = await planAndRun(c);
    expect((await gbrain(argv, { home: c.fx.home, env, timeoutMs: 900_000 })).code).toBe(0);
    const home = staleHome(c);
    const refused = await gbrain(['query', 'acme', '--json'], { home });
    expect(refused.code).not.toBe(0);
    expect(codeOf(refused.json)).toBe('engine_graduated');
    const fix = fixOf(refused.json)!;
    expect(['run', 'tell_user_to_run']).toContain(fix.next);
    expect(JSON.stringify(fix)).not.toContain(leakNeedle(passwordOf(c.target.url)));
    const fixed = await runFix(fix, home, c);
    expect({ code: fixed.code, stderr: fixed.code === 0 ? '' : fixed.stderr.slice(-1500) }).toEqual({ code: 0, stderr: '' });
    const retried = await gbrain(['get', 'people/alice-example', '--source', 'default'], { home });
    expect({ code: retried.code, stderr: retried.code === 0 ? '' : retried.stderr.slice(-1500) }).toEqual({ code: 0, stderr: '' });
    expect(retried.stdout).toContain('Alice-example');
  }, 900_000);

  graduationTest('a stale MCP server config surfaces engine_graduated through the MCP host and recovers after one fix', async () => {
    const c = await fresh('stale-mcp');
    const { argv, env } = await planAndRun(c);
    expect((await gbrain(argv, { home: c.fx.home, env, timeoutMs: 900_000 })).code).toBe(0);
    const home = staleHome(c);
    const stale = await mcpStdioSession({ home });
    const reply = await stale.call('get_page', { slug: 'people/alice-example', source_id: 'default' });
    const exited = await stale.close();
    const text = `${JSON.stringify(reply)}${exited.stdout}${exited.stderr}`;
    expect(text).toContain('engine_graduated');
    const fix = findFix(reply);
    expect(fix).not.toBeNull();
    const fixed = await runFix(fix!, home, c);
    expect(fixed.code).toBe(0);
    const relaunched = await mcpStdioSession({ home });
    const after = await relaunched.call('get_page', { slug: 'people/alice-example', source_id: 'default' });
    await relaunched.close();
    expect(after?.error).toBeUndefined();
    expect(JSON.stringify(after)).toContain('Alice-example');
  }, 900_000);
});

