/**
 * scripts/native/heartbeat.sh: the darwin-x64 native-locks heartbeat. A wedged macOS runner uploads no log, so the job
 * posts its state as the commit status diag/native-heartbeat while it runs. A fake curl on PATH records every post.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const SCRIPT = resolve(import.meta.dir, '../../scripts/native/heartbeat.sh');
const SECRET = 'planted-secret-value-example';
const TOKEN = 'ghs_fake_token_example';
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

type Post = { url: string; state: string; context: string; description: string; target_url: string };

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-heartbeat-'));
  roots.push(root);
  const bin = join(root, 'bin');
  const log = join(root, 'posts.ndjson');
  Bun.spawnSync(['mkdir', '-p', bin]);
  writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash
url="" data=""
while [ $# -gt 0 ]; do case "$1" in -d) data="$2"; shift 2 ;; -H|-o|-X|--max-time) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done
printf '{"url":"%s","body":%s}\\n' "$url" "$data" >> "${log}"
`);
  chmodSync(join(bin, 'curl'), 0o755);
  const env = (extra: Record<string, string> = {}): Record<string, string> => ({
    PATH: `${bin}:${process.env.PATH}`, HOME: root, GH_TOKEN: TOKEN, GITHUB_REPOSITORY: 'owner-example/repo-example', GITHUB_RUN_ID: '42',
    GBRAIN_HEARTBEAT_SHA: 'abc123', GBRAIN_HEARTBEAT_CELL: 'darwin-x64/1.4.4', GBRAIN_HEARTBEAT_DIR: join(root, 'state'),
    GBRAIN_HEARTBEAT_INTERVAL_S: '1', GBRAIN_HEARTBEAT_ENABLED: '1', GBRAIN_PLANTED_SECRET: SECRET, ...extra,
  });
  const run = (args: string[], extra?: Record<string, string>) => Bun.spawnSync(['bash', SCRIPT, ...args], { env: env(extra), stdout: 'pipe', stderr: 'pipe' });
  const posts = (): Post[] => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => {
    const { url, body } = JSON.parse(line) as { url: string; body: Omit<Post, 'url'> };
    return { url, ...body };
  }) : [];
  return { root, run, posts };
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('native heartbeat (diag/native-heartbeat)', () => {
  test('posts pending heartbeats naming the current suite, then one terminal success, all on one context with no secret', async () => {
    const box = sandbox();
    expect(box.run(['start']).exitCode).toBe(0);
    const pid = Number(readFileSync(join(box.root, 'state', 'pid'), 'utf8'));
    expect(box.run(['mark', 'test/backup-portability-native.serial.test.ts']).exitCode).toBe(0);
    await Bun.sleep(3500);
    expect(box.run(['stop', 'success']).exitCode).toBe(0);
    await Bun.sleep(500);
    expect(alive(pid)).toBe(false);
    const posts = box.posts();
    expect(posts.length).toBeGreaterThanOrEqual(3);
    for (const post of posts) {
      expect(post.context).toBe('diag/native-heartbeat');
      expect(post.url).toBe('https://api.github.com/repos/owner-example/repo-example/statuses/abc123');
      expect(post.target_url).toBe('https://github.com/owner-example/repo-example/actions/runs/42');
      expect(post.description.length).toBeLessThanOrEqual(140);
      expect(post.description).not.toContain(SECRET);
      expect(post.description).not.toContain(TOKEN);
      expect(post.description).toMatch(/^darwin-x64\/1\.4\.4 /);
      expect(post.description).toMatch(/\| free \d*% \| swap \S* \| load \S* \| top /);
    }
    expect(posts.slice(0, -1).every(post => post.state === 'pending')).toBe(true);
    expect(posts.some(post => post.description.includes(' backup-portability-native.serial.test.ts '))).toBe(true);
    expect(posts.at(-1)!.state).toBe('success');
    expect(posts.at(-1)!.description).toMatch(/^darwin-x64\/1\.4\.4 finished success \| /);
  }, 30_000);

  test('does nothing when disabled (a fork pull request)', async () => {
    const box = sandbox();
    for (const args of [['start'], ['mark', 'test/x.test.ts'], ['stop', 'success']]) expect(box.run(args, { GBRAIN_HEARTBEAT_ENABLED: '0' }).exitCode).toBe(0);
    await Bun.sleep(1500);
    expect(box.posts()).toEqual([]);
    expect(existsSync(join(box.root, 'state'))).toBe(false);
  }, 30_000);

  test('the loop ends on its own past the job deadline', async () => {
    const box = sandbox();
    expect(box.run(['start'], { GBRAIN_JOB_DEADLINE: String(Math.floor(Date.now() / 1000) - 400) }).exitCode).toBe(0);
    const pid = Number(readFileSync(join(box.root, 'state', 'pid'), 'utf8'));
    await Bun.sleep(1000);
    expect(alive(pid)).toBe(false);
    expect(box.posts()).toEqual([]);
  }, 30_000);
});
