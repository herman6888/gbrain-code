/**
 * Warm CLI socket: the guards that decide whether a CLI may talk to a serve.
 *
 * 1. Protects: the identity token changes with the brain, database target,
 *    config home, config bytes, behavior env and version (never with the
 *    password or a provider key's value); the run directory, the directories
 *    above it and the socket checks refuse symlinks, foreign owners, open
 *    permissions and a socket swapped after bind; the serve rejects a peer
 *    whose kernel-reported uid differs, refuses to start when peer credentials
 *    cannot be read or on a mount brain, refuses a mismatched identity, holds a
 *    request's slot until its work settles, and the CLI never connects without
 *    a peer-credential reader, bounds the whole exchange, and treats a dying
 *    serve or a malformed frame as its cold path.
 * 2. Fails when: a token input is dropped, a check follows a symlink or skips
 *    the uid comparison, the peer-credential branch is removed, or a frame
 *    field the CLI reads goes unchecked.
 * 3. The Postgres E2E (test/e2e/cli-socket-postgres.test.ts) exercises the
 *    happy path and fallbacks end to end; another uid cannot be produced there.
 * 4. Seams: startCliSocketServer's peerCred/identity/execute/home/brainId
 *    options, exchangeCliSocket's peerCred argument, FsGuardDeps.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { behaviorEnvDigest, canonicalDatabaseTarget, cliSocketIdentity } from '../src/core/cli-socket/identity.ts';
import {
  ancestorProblem, cliSocketPath, connectProblem, ensurePrivateDir, privateDirProblem, privateSocketProblem, trustedAncestorProblem, verifyBoundSocket, type FsGuardDeps,
} from '../src/core/cli-socket/fs-guard.ts';
import { peerCredSupport } from '../src/core/cli-socket/peer-cred.ts';
import { startCliSocketServer, type CliSocketBinding } from '../src/core/cli-socket/server.ts';
import { cliSocketRoundTripMs, exchangeCliSocket, renderOp } from '../src/cli/cli-socket-client.ts';
import { loadOperation } from '../src/core/operation-load.ts';
import { isResultFrame, reviveOperationError, serializeOperationError, type CliSocketRequest, type ResultFrame } from '../src/core/cli-socket/protocol.ts';
import { queueFirstFallbackHop, takeChatFallbackHopNotices, __resetChatFallbackHopNoticeForTests } from '../src/core/ai/fallback-hop-queue.ts';
import { installOutputCapture, OutputCapture, withOutputCapture } from '../src/core/cli-socket/output-capture.ts';
import { opError, OperationError } from '../src/core/ops/contract.ts';
import { loadConfigWithEngine, type GBrainConfig } from '../src/core/config.ts';

const uid = process.getuid!();
const engine = { kind: 'postgres', connectedDatabaseUrl: 'postgresql://alice-example@db.acme-example.test/brain' } as unknown as BrainEngine;
const okFrame: ResultFrame = { v: 1, kind: 'result', result: ['ok'], meta: null, notices: [], output: [], source: null };

/** A run directory under a private home, as the serve lays it out: <root>/home/.gbrain/run. */
function runDir(): string {
  const dir = join(root, 'home', '.gbrain', 'run');
  ensurePrivateDir(dir);
  return dir;
}
let root: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gbrain-cli-sock-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function homeWithConfig(name: string, body = '{"engine":"postgres"}'): { dir: string; file: string } {
  const dir = join(root, name, '.gbrain');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), body);
  return { dir, file: join(dir, 'config.json') };
}

describe('identity token', () => {
  const url = 'postgresql://alice-example:secret-one@db.acme-example.test:6543/brain?sslmode=require&application_name=x';
  const token = (overrides: Partial<Parameters<typeof cliSocketIdentity>[0]> = {}) => {
    const dir = join(root, 'a', '.gbrain');
    return cliSocketIdentity({ config: { engine: 'postgres', database_url: url }, brainId: 'host', configDir: dir, configFile: join(dir, 'config.json'), version: '1.0.0', env: {}, ...overrides });
  };

  test('ignores the password and query-parameter order, keeps host, port, database and user', () => {
    expect(canonicalDatabaseTarget(url)).toBe(canonicalDatabaseTarget('postgres://alice-example:other@DB.acme-example.test:6543/brain?application_name=x&sslmode=require'));
    expect(canonicalDatabaseTarget(url)).not.toContain('secret-one');
    for (const other of [
      url.replace(':6543', ':5432'), url.replace('/brain', '/brain2'), url.replace('db.acme', 'db2.acme'), url.replace('alice-example', 'bob-example'),
    ]) expect(canonicalDatabaseTarget(other)).not.toBe(canonicalDatabaseTarget(url));
  });

  test('changes with the database, config home, config bytes and version', () => {
    const home = homeWithConfig('a');
    const base = token();
    expect(token()).toBe(base);
    expect(token({ config: { engine: 'postgres', database_url: url.replace('secret-one', 'rotated') } })).toBe(base);
    expect(token({ config: { engine: 'postgres', database_url: url.replace('/brain', '/other') } })).not.toBe(base);
    expect(token({ version: '1.0.1' })).not.toBe(base);
    const other = homeWithConfig('b');
    expect(token({ configDir: other.dir, configFile: other.file })).not.toBe(base);
    writeFileSync(home.file, '{"engine":"postgres","edited":true}');
    expect(token()).not.toBe(base);
  });

  test('changes with the resolved brain id (a mount serve never matches a host CLI)', () => {
    homeWithConfig('a');
    expect(token({ brainId: 'mnt-example' })).not.toBe(token());
  });

  test('changes with GBRAIN_* settings and which provider keys are set, never with a key value or the socket/debug switches', () => {
    homeWithConfig('a');
    const base = token({ env: { HOME: '/home/alice-example', GBRAIN_HOME: '/home/alice-example' } });
    expect(token({ env: { HOME: '/elsewhere', GBRAIN_HOME: '/home/alice-example' } })).toBe(base);
    expect(token({ env: { GBRAIN_HOME: '/home/alice-example', GBRAIN_CONTRIBUTOR_MODE: '1' } })).not.toBe(base);
    expect(token({ env: { GBRAIN_HOME: '/home/alice-example', GBRAIN_CLI_SOCKET: '1', GBRAIN_DEBUG: '1', GBRAIN_SQL_TRACE: '/tmp/t.jsonl' } })).toBe(base);
    const keyed = behaviorEnvDigest({ VOYAGE_API_KEY: 'value-one' });
    expect(behaviorEnvDigest({ VOYAGE_API_KEY: 'value-two' })).toBe(keyed);
    expect(behaviorEnvDigest({})).not.toBe(keyed);
    expect(behaviorEnvDigest({ VOYAGE_API_KEY: '' })).toBe(behaviorEnvDigest({}));
    expect(behaviorEnvDigest({ OPENAI_BASE_URL: 'http://localhost:1' })).not.toBe(behaviorEnvDigest({}));
    expect(JSON.stringify(behaviorEnvDigest({ VOYAGE_API_KEY: 'value-one' }))).not.toContain('value-one');
  });

  test('provider routing values enter the digest (a local and a remote endpoint never match); credentials stay set-or-not', () => {
    homeWithConfig('a');
    const local = { GBRAIN_HOME: '/home/alice-example', OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1' };
    const remote = { GBRAIN_HOME: '/home/alice-example', OPENAI_BASE_URL: 'https://api.openai.com/v1' };
    expect(behaviorEnvDigest(local)).not.toBe(behaviorEnvDigest(remote));
    expect(token({ env: local })).not.toBe(token({ env: remote }));
    for (const name of ['OLLAMA_BASE_URL', 'LMSTUDIO_BASE_URL', 'LLAMA_SERVER_BASE_URL', 'LLAMA_SERVER_RERANKER_BASE_URL', 'LITELLM_BASE_URL', 'OPENROUTER_BASE_URL',
      'ANTHROPIC_BASE_URL', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT', 'AZURE_OPENAI_API_VERSION', 'OPENAI_ORG_ID', 'OPENAI_PROJECT', 'MINIMAX_GROUP_ID']) {
      expect(behaviorEnvDigest({ [name]: 'value-one' }), name).not.toBe(behaviorEnvDigest({ [name]: 'value-two' }));
    }
    for (const name of ['OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'LLAMA_SERVER_API_KEY']) {
      expect(behaviorEnvDigest({ [name]: 'value-one' }), name).toBe(behaviorEnvDigest({ [name]: 'value-two' }));
    }
  });

  test('GBRAIN_SOURCE stays out of the digest: it travels with each request and is resolved per call', () => {
    expect(behaviorEnvDigest({ GBRAIN_SOURCE: 'source-a' })).toBe(behaviorEnvDigest({}));
    expect(behaviorEnvDigest({ GBRAIN_SOURCE: 'source-a' })).toBe(behaviorEnvDigest({ GBRAIN_SOURCE: 'source-b' }));
  });
});

describe('run directory and socket checks', () => {
  test('ensurePrivateDir creates 0700, tightens an open directory this uid owns, refuses a symlink', () => {
    const dir = join(root, 'home', '.gbrain', 'run');
    ensurePrivateDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    chmodSync(dir, 0o755);
    expect(privateDirProblem(dir)).toBe('open_permissions');
    ensurePrivateDir(dir);
    expect(privateDirProblem(dir)).toBeNull();
    const link = join(root, 'link-run');
    symlinkSync(dir, link);
    expect(privateDirProblem(link)).toBe('symlink');
    expect(() => ensurePrivateDir(link)).toThrow(/symlink/);
  });

  test('a directory or socket owned by another uid is refused, never repaired', () => {
    const dir = runDir();
    const foreign: FsGuardDeps = { lstat: path => lstatSync(path), stat: path => statSync(path), uid: () => uid + 1 };
    expect(privateDirProblem(dir, foreign)).toBe('foreign_owner');
    expect(() => ensurePrivateDir(dir, foreign)).toThrow(/foreign_owner/);
    expect(privateDirProblem(dir, { ...foreign, uid: () => undefined })).toBe('no_uid');
  });

  test('the CLI refuses a regular file, a symlinked socket and an open socket before connecting', async () => {
    const dir = runDir();
    const path = join(dir, 'cli.sock');
    expect(connectProblem(path, dir)).toBe('missing');
    writeFileSync(path, 'x');
    expect(privateSocketProblem(path)).toBe('not_socket');
    rmSync(path);
    const real = join(root, 'real.sock');
    const server = net.createServer();
    await new Promise<void>(resolve => server.listen(real, resolve));
    try {
      symlinkSync(real, path);
      expect(connectProblem(path, dir)).toBe('symlink');
      rmSync(path);
      chmodSync(real, 0o666);
      expect(privateSocketProblem(real)).toBe('open_permissions');
      chmodSync(real, 0o600);
      expect(privateSocketProblem(real)).toBeNull();
      expect(privateSocketProblem(real, { lstat: p => lstatSync(p), uid: () => uid + 1 })).toBe('foreign_owner');
    } finally {
      server.close();
    }
  });

  test('GBRAIN_HOME and .gbrain must be this user\'s and writable by no one else (sticky excepted), on both sides', () => {
    const dir = runDir();
    const home = join(root, 'home');
    const path = join(dir, 'cli.sock');
    expect(ancestorProblem(dir)).toBeNull();
    for (const [target, mode] of [[home, 0o775], [home, 0o757], [join(home, '.gbrain'), 0o770]] as const) {
      chmodSync(target, mode);
      expect(ancestorProblem(dir)).toEqual({ path: target, reason: 'open_permissions' });
      expect(connectProblem(path, dir)).toBe('open_permissions');
      expect(() => ensurePrivateDir(dir)).toThrow(/open_permissions/);
      chmodSync(target, 0o700);
    }
    chmodSync(home, 0o1777);
    expect(trustedAncestorProblem(home)).toBeNull();
    chmodSync(home, 0o700);
    const foreignHome: FsGuardDeps = { lstat: p => lstatSync(p), stat: p => p === home ? { ...statSync(p), isDirectory: () => true, uid: uid + 1 } as never : statSync(p), uid: () => uid };
    expect(ancestorProblem(dir, foreignHome)).toEqual({ path: home, reason: 'foreign_owner' });
    expect(() => ensurePrivateDir(dir, foreignHome)).toThrow(/foreign_owner/);
  });

  test('a bound socket is only verified, never chmod\'ed: an open, symlinked or foreign one is refused as found', async () => {
    const dir = runDir();
    const path = join(dir, 'cli.sock');
    const server = net.createServer();
    const umask = process.umask(0o022);
    try { await new Promise<void>(resolve => server.listen(path, resolve)); } finally { process.umask(umask); }
    try {
      const real: FsGuardDeps = { lstat: p => lstatSync(p), uid: () => uid };
      const openMode = lstatSync(path).mode & 0o777;
      expect(openMode & 0o077).not.toBe(0);
      expect(() => verifyBoundSocket(path, real)).toThrow(/open_permissions/);
      expect(lstatSync(path).mode & 0o777).toBe(openMode);
      chmodSync(path, 0o600);
      expect(verifyBoundSocket(path, real)).toBe(lstatSync(path).ino);
      expect(() => verifyBoundSocket(path, { ...real, lstat: p => ({ ...lstatSync(p), isSymbolicLink: () => true, isSocket: () => false }) as never })).toThrow(/symlink/);
      expect(() => verifyBoundSocket(path, { ...real, uid: () => uid + 1 })).toThrow(/foreign_owner/);
    } finally {
      server.close();
    }
  });
});

describe('serve listener', () => {
  const bindings: CliSocketBinding[] = [];
  afterEach(() => { for (const b of bindings.splice(0)) b.close(); });

  const request = (identity: string): CliSocketRequest => ({ v: 1, identity, command: 'search', kind: 'op', op: 'search', params: { query: 'q' },
    routing: { cwd: '/', source_env: null }, cli: { quiet: false, timeout_ms: null } });

  async function start(overrides: Partial<Parameters<typeof startCliSocketServer>[0]> = {}) {
    const lines: string[] = [];
    const home = join(root, 'home', '.gbrain');
    const binding = await startCliSocketServer({ engine, log: line => lines.push(line), home, identity: 'token-a', brainId: () => 'host',
      execute: async () => ({ frame: okFrame, settled: Promise.resolve() }), ...overrides });
    if (binding) bindings.push(binding);
    return { binding, lines, path: cliSocketPath(home) };
  }

  test('this platform reads peer credentials (otherwise the serve would refuse to start)', () => {
    if (process.platform === 'linux' || process.platform === 'darwin') expect(peerCredSupport().ok).toBe(true);
  });

  test('binds 0600 even under an open process umask (the kernel creates it so), restores the umask, and answers a matching identity; refuses a mismatched one', async () => {
    const umask = process.umask(0o000);
    let started: Awaited<ReturnType<typeof start>>;
    try { started = await start(); expect(process.umask()).toBe(0o000); } finally { process.umask(umask); }
    const { binding, path } = started;
    expect(binding).not.toBeNull();
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(await exchangeCliSocket(path, request('token-a'), 5_000)).toEqual({ frame: okFrame });
    expect(await exchangeCliSocket(path, request('token-b'), 5_000)).toEqual({ reason: 'refused (identity_mismatch)' });
  });

  test('rejects a peer whose kernel uid differs, and one whose uid cannot be read', async () => {
    let calls = 0;
    // The first read is the start-up self-test on this process's own connection.
    const { binding, path, lines } = await start({ peerCred: { ok: true, read: () => (calls++ === 0 ? uid : uid + 1) } });
    expect(binding).not.toBeNull();
    const outcome = await exchangeCliSocket(path, request('token-a'), 5_000);
    expect('reason' in outcome && outcome.reason).toMatch(/^serve_closed|connect_failed|lost/);
    expect(lines.join('\n')).toContain(`rejected a connection from uid ${uid + 1}`);
    binding!.close();
    bindings.length = 0;
    calls = 0;
    const second = await start({ peerCred: { ok: true, read: () => (calls++ === 0 ? uid : null) } });
    expect(await exchangeCliSocket(second.path, request('token-a'), 5_000)).toHaveProperty('reason');
    expect(second.lines.join('\n')).toContain('rejected a connection from an unverifiable peer');
  });

  test('fails closed when peer credentials are unsupported or the self-test sees another uid', async () => {
    const unsupported = await start({ peerCred: { ok: false, reason: 'no peer-credential call is wired for testos' } });
    expect(unsupported.binding).toBeNull();
    expect(unsupported.lines.join('\n')).toContain('peer credentials cannot be verified on this platform (no peer-credential call is wired for testos)');
    expect(() => lstatSync(unsupported.path)).toThrow();
    const wrong = await start({ peerCred: { ok: true, read: () => uid + 1 } });
    expect(wrong.binding).toBeNull();
    expect(wrong.lines.join('\n')).toContain('self-test');
  });

  test('refuses PGLite brains and a symlinked run directory', async () => {
    expect((await start({ engine: { kind: 'pglite' } as BrainEngine })).binding).toBeNull();
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o700 });
    mkdirSync(join(root, 'home', '.gbrain'), { recursive: true });
    symlinkSync(elsewhere, join(root, 'home', '.gbrain', 'run'));
    const { binding, lines } = await start();
    expect(binding).toBeNull();
    expect(lines.join('\n')).toContain('(symlink)');
  });

  test('refuses to start on a mount brain, or when the engine does not report the database it connected to', async () => {
    const mount = await start({ brainId: () => 'mnt-example' });
    expect(mount.binding).toBeNull();
    expect(mount.lines.join('\n')).toContain('this serve is on mount brain "mnt-example"');
    expect(() => lstatSync(mount.path)).toThrow();
    const unknown = await start({ engine: { kind: 'postgres' } as BrainEngine });
    expect(unknown.binding).toBeNull();
    expect(unknown.lines.join('\n')).toContain('does not report the database it connected to');
  });

  test('a request holds its slot until its work settles, not until it answered', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const { path } = await start({ execute: async () => ({ frame: { v: 1, kind: 'fallback', reason: 'timeout' }, settled: pending }) });
    for (let i = 0; i < 8; i++) expect(await exchangeCliSocket(path, request('token-a'), 5_000)).toEqual({ frame: { v: 1, kind: 'fallback', reason: 'timeout' } });
    expect(await exchangeCliSocket(path, request('token-a'), 5_000)).toEqual({ reason: 'refused (busy)' });
    release();
    await Bun.sleep(20);
    expect(await exchangeCliSocket(path, request('token-a'), 5_000)).toHaveProperty('frame');
  });

  test('a request whose work is still unsettled at the round-trip cap is logged once', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const { path, lines } = await start({ stuckAfterMs: 50, execute: async () => ({ frame: { v: 1, kind: 'fallback', reason: 'timeout' }, settled: pending }) });
    await exchangeCliSocket(path, request('token-a'), 5_000);
    await Bun.sleep(150);
    expect(lines.filter(line => line.includes('is still running')).length).toBe(1);
    expect(lines.join('\n')).toContain('a search request is still running');
    release();
    await Bun.sleep(20);
    const { path: second, lines: quiet } = await start({ home: join(root, 'quiet', '.gbrain'), stuckAfterMs: 50 } as never);
    await exchangeCliSocket(second, request('token-a'), 5_000);
    await Bun.sleep(150);
    expect(quiet.filter(line => line.includes('is still running'))).toEqual([]);
  });

  test('without a peer-credential reader the CLI never connects', async () => {
    const { path } = await start();
    let connections = 0;
    const counter = net.createServer(socket => { connections++; socket.destroy(); });
    const probe = join(runDir(), 'probe.sock');
    await new Promise<void>(resolve => counter.listen(probe, resolve));
    try {
      expect(await exchangeCliSocket(probe, request('token-a'), 5_000, { ok: false, reason: 'no peer-credential call is wired for testos' }))
        .toEqual({ reason: 'peer_credentials_unsupported (no peer-credential call is wired for testos)' });
      await Bun.sleep(20);
      expect(connections).toBe(0);
      expect(await exchangeCliSocket(path, request('token-a'), 5_000)).toEqual({ frame: okFrame });
    } finally {
      counter.close();
    }
  });

  test('a response frame missing a field the CLI reads, or of an unknown kind, is malformed', async () => {
    const valid: unknown[] = [okFrame, { v: 1, kind: 'error', error: { code: 'page_not_found', message: 'm' }, output: [['stderr', 'x']] }, { v: 1, kind: 'fallback', reason: 'r' }];
    for (const frame of valid) expect(isResultFrame(frame)).toBe(true);
    const malformed: unknown[] = [
      { v: 1, kind: 'result', result: 1, meta: null, notices: [] },
      { v: 1, kind: 'result', result: 1, meta: null, notices: [], output: [['stdout']] },
      { v: 1, kind: 'result', result: 1, meta: 'x', notices: [], output: [] },
      { v: 1, kind: 'result', result: 1, meta: null, notices: [{}], output: [] },
      { v: 1, kind: 'result', result: 1, meta: null, notices: [{ code: 'x' }], output: [] },
      { v: 1, kind: 'error', output: [] },
      { v: 1, kind: 'error', error: { message: 'no code' }, output: [] },
      { v: 1, kind: 'timeout', label: 'l', ms: 1, output: [] },
      { v: 1, kind: 'mystery' },
      { v: 1, kind: 'fallback' },
      { v: 2, kind: 'fallback', reason: 'r' },
    ];
    for (const frame of malformed) expect(isResultFrame(frame)).toBe(false);
    const dir = runDir();
    const path = join(dir, 'cli.sock');
    const lines = [JSON.stringify(malformed[0]), JSON.stringify({ v: 1, accepted: 'yes' })];
    for (const [handshake, result] of [['{"v":1,"accepted":true}', lines[0]], [lines[1], '']] as const) {
      const server = net.createServer(socket => socket.once('data', () => socket.write(`${handshake}\n${result}${result ? '\n' : ''}`)));
      await new Promise<void>(resolve => server.listen(path, resolve));
      try {
        expect(await exchangeCliSocket(path, request('token-a'), 5_000)).toEqual({ reason: 'malformed_response' });
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    }
  });

  test('the whole exchange is bounded: about 30 s, or the CLI\'s --timeout when shorter', async () => {
    expect(cliSocketRoundTripMs(null)).toBe(30_000);
    expect(cliSocketRoundTripMs(5_000)).toBe(5_000);
    expect(cliSocketRoundTripMs(600_000)).toBe(30_000);
    const path = join(runDir(), 'cli.sock');
    const server = net.createServer(socket => socket.once('data', () => socket.write('{"v":1,"accepted":true}\n')));
    await new Promise<void>(resolve => server.listen(path, resolve));
    try {
      const started = performance.now();
      expect(await exchangeCliSocket(path, request('token-a'), 300)).toEqual({ reason: 'round_trip_timeout' });
      expect(performance.now() - started).toBeLessThan(2_000);
    } finally {
      server.close();
    }
  });

  test('a serve that dies after the handshake sends the CLI to its cold path', async () => {
    const path = join(runDir(), 'cli.sock');
    const server = net.createServer(socket => socket.once('data', () => { socket.write('{"v":1,"accepted":true}\n'); setTimeout(() => socket.destroy(), 20); }));
    await new Promise<void>(resolve => server.listen(path, resolve));
    try {
      expect(await exchangeCliSocket(path, request('token-a'), 5_000)).toEqual({ reason: 'serve_closed_mid_request' });
    } finally {
      server.close();
    }
  });

  test('a wedged serve that never answers the handshake is abandoned within the handshake timeout', async () => {
    const path = join(runDir(), 'cli.sock');
    const server = net.createServer(() => { /* never answers */ });
    await new Promise<void>(resolve => server.listen(path, resolve));
    try {
      const started = performance.now();
      expect(await exchangeCliSocket(path, request('token-a'), 60_000)).toEqual({ reason: 'handshake_timeout' });
      expect(performance.now() - started).toBeLessThan(3_000);
    } finally {
      server.close();
    }
  });
});

test('a well-formed frame whose payload the renderer cannot handle prints nothing and sends the CLI to its cold path', async () => {
  const op = (await loadOperation('search'))!;
  const written: string[] = [];
  const saved = { out: process.stdout.write, err: process.stderr.write };
  const record = (chunk: unknown) => { written.push(String(chunk)); return true; };
  process.stdout.write = record as typeof process.stdout.write;
  process.stderr.write = record as typeof process.stderr.write;
  let outcome: boolean | Error;
  try {
    outcome = await renderOp('search', op, { query: 'q' }, { v: 1, kind: 'result', result: 5, meta: null, notices: [], output: [['stdout', 'handler line\n']], source: null })
      .catch((error: Error) => error);
  } finally {
    Object.assign(process.stdout, { write: saved.out });
    Object.assign(process.stderr, { write: saved.err });
  }
  expect(outcome).toBe(false);
  expect(written).toEqual([]);
});

test('each warm request has its own first chat-fallback hop queue; the process queue is untouched', async () => {
  installOutputCapture();
  __resetChatFallbackHopNoticeForTests();
  const hop = (why: string) => () => ({ code: 'chat_fallback_hop', kind: 'safety', why }) as never;
  expect(queueFirstFallbackHop(hop('process'))).toBe(true);
  const seen: unknown[][] = [];
  for (const name of ['a', 'b']) {
    await withOutputCapture(new OutputCapture(), async () => {
      expect(queueFirstFallbackHop(hop(name))).toBe(true);
      expect(queueFirstFallbackHop(hop(`${name}-again`))).toBe(false);
      seen.push(takeChatFallbackHopNotices());
    });
  }
  expect(seen).toEqual([[{ code: 'chat_fallback_hop', kind: 'safety', why: 'a' }], [{ code: 'chat_fallback_hop', kind: 'safety', why: 'b' }]]);
  expect(takeChatFallbackHopNotices()).toEqual([{ code: 'chat_fallback_hop', kind: 'safety', why: 'process' }]);
  __resetChatFallbackHopNoticeForTests();
});

test('an OperationError round-trips with every field the CLI renderer reads', () => {
  const original = opError('page_not_found', 'Page not found: notes/alpha-example', 'Check the slug.', {
    fix: { argv: ['gbrain', 'get', 'notes/alpha-example', '--include-deleted'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Shows deleted pages too.' },
  });
  const revived = reviveOperationError(JSON.parse(JSON.stringify(serializeOperationError(original))));
  expect(revived).toBeInstanceOf(OperationError);
  expect(revived.toJSON()).toEqual(original.toJSON());
  expect({ ...revived }).toEqual({ ...original });
});

test('serve.cli_socket joins the connect-time config merge from its bulk snapshot only, never a read of its own', async () => {
  const base: GBrainConfig = { engine: 'postgres' };
  const reads: string[] = [];
  const reader = (table: Record<string, string> | null) => ({
    getConfig: async (key: string) => { reads.push(key); return table?.[key] ?? null; },
    ...(table ? { getAllConfig: async () => ({ ...table }) } : {}),
  });
  expect((await loadConfigWithEngine(reader({ 'serve.cli_socket': ' Yes ' }), base))?.serve_cli_socket).toBe(true);
  expect((await loadConfigWithEngine(reader({ 'serve.cli_socket': 'false' }), base))?.serve_cli_socket).toBe(false);
  expect((await loadConfigWithEngine(reader({}), base))?.serve_cli_socket).toBeUndefined();
  expect(reads).toEqual([]);
  const perKey = await loadConfigWithEngine({ getConfig: async (key: string) => { reads.push(key); return key === 'serve.cli_socket' ? 'true' : null; } }, base);
  expect(perKey?.serve_cli_socket).toBeUndefined();
  expect(reads.length).toBeGreaterThan(0);
  expect(reads).not.toContain('serve.cli_socket');
});
