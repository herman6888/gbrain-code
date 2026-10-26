/**
 * G8a of git-canonical memory (docs/designs/GIT_CANONICAL_MEMORY.md#conversion): `gbrain sources canonical <id> --to git|mixed`.
 * A mixed source with every category present converts with the right action for each: database_ahead and undeclared
 * pages are written from the database and committed through the door (one commit per group), declared pages stay
 * database-only, a page Git moved is indexed, a held deletion and an unknown-side drift take Git's side, a parked effect
 * on an ignored path is reclassified as declared. Afterwards the tree is clean, the census shows no gap, the adopted rows
 * kept their revisions and a G3 pass changes nothing. A stale hash refuses; database content that would be discarded
 * refuses and writes nothing; a crash after a group's commit leaves the source non-strict and a rerun completes once;
 * --to mixed round-trips; remote callers and unmanaged brains cannot reach it.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { operations } from '../src/core/operations.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { acquireWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { resolveManagedSyncContext } from '../src/core/persistence/sync-discovery.ts';
import { applyGitConversion, applyMixedConversion, CONVERSION_GROUP_MAX, planGitConversion, planMixedConversion } from '../src/core/persistence/git-conversion.ts';
import { withSubmissionAuthority } from '../src/core/minions/submission-authority.ts';
import { censusGitGap } from '../src/commands/sources-git-gap.ts';
import { runSourcesCanonical } from '../src/commands/sources-canonical.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { managedBrain, type ManagedBrain } from './helpers/managed-brain.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const note = (slug: string, body: string, extra = '') => '---\ntype: concept\ntitle: ' + slug + '\n' + extra + '---\n\n' + body + '\n';
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const PROCESSING = { noEmbed: true, noExtract: true };
const putPage = operations.find(op => op.name === 'put_page')!;

const strict = async (engine: BrainEngine) => (await engine.executeRaw<{ s: boolean }>("SELECT COALESCE(config->>'canonical','')='git' AS s FROM sources WHERE id='default'"))[0]!.s;
const page = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ body: string; deleted: boolean; revision: string }>(
  "SELECT compiled_truth AS body, deleted_at IS NOT NULL AS deleted, knowledge_revision::text AS revision FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0];
const revisions = async (engine: BrainEngine) => Object.fromEntries((await engine.executeRaw<{ slug: string; revision: string }>(
  "SELECT slug, knowledge_revision::text AS revision FROM pages WHERE source_id='default' AND deleted_at IS NULL ORDER BY slug")).map(row => [row.slug, row.revision]));
const holds = async (engine: BrainEngine) => (await engine.executeRaw<{ r: { path: string; code: string } }>(
  "SELECT completed_keys->0 AS r FROM op_checkpoints WHERE op='sync-hold' ORDER BY fingerprint")).map(({ r }) => `${r.path} ${r.code}`);
/** A database-only edit: the page moves to a revision no request and no import wrote. */
const databaseOnlyEdit = (engine: BrainEngine, slug: string, body: string) => engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(
  "UPDATE pages SET compiled_truth=$1, knowledge_revision=$2::uuid, revision_write_request_id=NULL WHERE source_id='default' AND slug=$3", [body, randomUUID(), slug]), TEST_WRITE_ATTRIBUTION));
/** A page written while write-through is off: a row with no file. */
async function databaseOnlyPage(brain: ManagedBrain, slug: string, content: string): Promise<void> {
  await brain.engine.setConfig('sync.write_through', 'false');
  try { await putPage.handler(brain.ctx, { slug, content, wait_ms: 30_000 }); } finally { await brain.engine.setConfig('sync.write_through', 'true'); }
}
const conversionCommits = (root: string, since: string) => git(root, 'log', '--reverse', '--format=@%s', '--name-only', `${since}..HEAD`).split('@').filter(Boolean)
  .map(entry => { const [subject, ...paths] = entry.trim().split('\n').filter(Boolean); return { subject, paths: paths.sort() }; });

async function cli(engine: BrainEngine, args: string[]): Promise<Record<string, any>> {
  const lines: string[] = [];
  const log = console.log, priorExitCode = process.exitCode;
  console.log = (line: unknown) => { lines.push(String(line)); };
  try { await runSourcesCanonical(engine, [...args, '--json']); } finally { console.log = log; _resetCliExitVerdictForTests(); process.exitCode = priorExitCode ?? 0; }
  return JSON.parse(lines.at(-1)!);
}

/** A Git effect parked on an ignored target, as an older gbrain left one (the census test's fixture, test/git-gap-census.test.ts). */
async function parkIgnoredEffect(engine: BrainEngine, slug: string, code = 'git_target_ignored'): Promise<void> {
  const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.persistence_protocol','2',true)");
    // Already terminal (state failed), as a parked receipt is: no owner pass claims it.
    const [request] = await tx.executeRaw<{ id: string }>(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,authority,
        intent_bytes,terminal_reservation,state,completed_at) VALUES ('local_cli','test',$1::uuid,'put_page','default',$2::uuid,$3,'x','{}'::jsonb,0,16384,'failed',now()) RETURNING id::text`, [randomUUID(), incarnation, slug]);
    await tx.executeRaw(`INSERT INTO persistence_effects(request_id,kind,data,state,error_code,source_id,source_incarnation) VALUES ($1::uuid,'git',$2::text::jsonb,'failed','targets_parked','default',$3::uuid)`,
      [request!.id, JSON.stringify({ parked: [{ slug, error_code: code, rule: '.gitignore:1: scratch/' }] }), incarnation]);
  });
}

const SLUGS = ['notes/same', 'notes/ahead', 'notes/gitmoved', 'notes/drift', 'notes/removed', 'notes/legacy'];
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  // The door commits with the repository's own identity: CI runners have no global one.
  git(root, 'config', 'user.name', 'Example Writer'); git(root, 'config', 'user.email', 'writer@example.invalid');
  writeFileSync(join(root, '.gitignore'), 'scratch/\n');
  for (const slug of SLUGS) writeFileSync(join(root, `${slug}.md`), note(slug, `The committed body of ${slug}.`));
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'notes');
};

const BULK = CONVERSION_GROUP_MAX + 1;
const bulkSetup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'bulk'), { recursive: true }); git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Example Writer'); git(root, 'config', 'user.email', 'writer@example.invalid');
  for (let i = 0; i < BULK; i++) writeFileSync(join(root, `bulk/p${String(i).padStart(3, '0')}.md`), note(`bulk/p${i}`, `Committed body ${i}.`));
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'bulk');
};

/** The page loses its sync import record, as a page imported before records were written has none. */
async function dropImportRecord(engine: BrainEngine, slug: string): Promise<void> {
  const [row] = await engine.executeRaw<{ id: string }>("SELECT id::text FROM pages WHERE source_id='default' AND slug=$1", [slug]);
  await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='sync-import-provenance' AND fingerprint LIKE $1", [`default:%:${row!.id}`]);
}

const DRIFT_COMMITTED = 'The committed edit of notes/drift.';
/**
 * Every category on one non-strict source: notes/ahead and notes/dbonly hold content Git lacks, and notes/legacy has no
 * import record and a database edit (adopt); notes/secret is private and scratch/ignored is under an ignored path whose
 * Git effect parked (declared, reclassified); notes/gitmoved got a commit sync has not read (git wins); notes/removed was
 * deleted in Git after a database edit (held deletion, Git wins); notes/drift moved on both sides without an import record
 * (held, side unknown); a later database write that matches the commit (`driftMatches`) leaves the hold with nothing to
 * lose, so Git wins; otherwise the database edit would be discarded.
 */
async function mixedSource(brain: ManagedBrain, driftMatches = true): Promise<void> {
  const { engine, root } = brain;
  expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
  for (const slug of ['notes/ahead', 'notes/drift', 'notes/removed', 'notes/legacy']) await databaseOnlyEdit(engine, slug, `Written to the database alone: ${slug}.`);
  writeFileSync(join(root, 'notes/drift.md'), note('notes/drift', DRIFT_COMMITTED));
  git(root, 'rm', '-q', 'notes/removed.md'); git(root, 'commit', '-qam', 'edit drift, remove removed');
  await dropImportRecord(engine, 'notes/drift');
  await dropImportRecord(engine, 'notes/legacy');
  await databaseOnlyPage(brain, 'notes/dbonly', note('notes/dbonly', 'Only in the database.'));
  await databaseOnlyPage(brain, 'notes/secret', note('notes/secret', 'A private note.', 'visibility: private\n'));
  await putPage.handler(brain.ctx, { slug: 'scratch/ignored', content: note('scratch/ignored', 'Under an ignored path.'), wait_ms: 30_000 });
  await parkIgnoredEffect(engine, 'scratch/ignored');
  await performManagedSync(engine, OPTS);
  expect(await holds(engine)).toEqual(['notes/drift.md file_drift', 'notes/removed.md file_drift']);
  if (driftMatches) await databaseOnlyEdit(engine, 'notes/drift', DRIFT_COMMITTED);
  writeFileSync(join(root, 'notes/gitmoved.md'), note('notes/gitmoved', 'The committed edit of notes/gitmoved.'));
  git(root, 'commit', '-qam', 'edit gitmoved');
}

for (const backend of testBackends()) describe(`[${backend}] G8a: sources canonical converts a source to git-canonical and back`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('a mixed source with every category converts with the right action for each', () => managedBrain(async brain => {
    const { engine, root } = brain;
    await mixedSource(brain);
    const base = git(root, 'rev-parse', 'HEAD');
    const before = await revisions(engine);
    const { preview } = await planGitConversion(engine, 'default');
    expect(preview).toMatchObject({ strict: false, adopt: { count: 3, groups: 1, by: { database_ahead: 2, undeclared_database_only: 1, worktree_only: 0 } },
      declared: { count: 2, by: { private: 1, git_ignored: 1 } }, git_wins: { count: 3, by: { git_ahead: 1, held_deletion: 1, held_drift_unknown: 1, deleted_by_commit: 0 } },
      holds: { count: 2, by: { 'file_drift:unknown': 1, 'file_drift:deleted': 1 } }, parked_effects: { count: 1, retry: 0, reclassify: 1 }, discard: { count: 0 } });
    expect(preview.adopt.sample.sort()).toEqual(['notes/ahead.md', 'notes/dbonly.md', 'notes/legacy.md']);
    expect(preview.git_wins.sample.sort()).toEqual(['notes/drift.md', 'notes/gitmoved.md', 'notes/removed.md']);
    expect(await strict(engine)).toBe(false);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(base);

    const result = await applyGitConversion(engine, 'default', preview.preview_hash, PROCESSING);
    expect(result).toMatchObject({ status: 'converted', committed: { groups: 1, pages: 3 }, holds_cleared: 2, parked: { reclassified: 1 },
      after: { remaining: 0, strict: true, parked_effects: { count: 0 } } });
    expect(await strict(engine)).toBe(true);
    expect(conversionCommits(root, base)).toEqual([{ subject: 'gbrain: persist 3 canonical memory updates', paths: ['notes/ahead.md', 'notes/dbonly.md', 'notes/legacy.md'] }]);
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(root, 'notes/ahead.md'), 'utf8')).toContain('Written to the database alone: notes/ahead.');
    const after = await revisions(engine);
    expect(after['notes/ahead']).toBe(before['notes/ahead']);
    expect(after['notes/dbonly']).toBe(before['notes/dbonly']);
    // A page with no import record is adopted into Git before the strict import runs, so its database body is committed, never overwritten.
    expect(readFileSync(join(root, 'notes/legacy.md'), 'utf8')).toContain('Written to the database alone: notes/legacy.');
    expect(after['notes/legacy']).toBe(before['notes/legacy']);
    expect((await page(engine, 'notes/legacy'))!.body).toContain('Written to the database alone: notes/legacy.');
    expect(after['notes/same']).toBe(before['notes/same']);
    expect((await page(engine, 'notes/gitmoved'))!.body).toContain('The committed edit of notes/gitmoved.');
    expect((await page(engine, 'notes/drift'))!.body).toContain(DRIFT_COMMITTED);
    expect((await page(engine, 'notes/removed'))!.deleted).toBe(true);
    expect((await page(engine, 'notes/secret'))!.deleted).toBe(false);
    // The page under an ignored path stays database-only (declared git_ignored): no file is written, no git_target_ignored round trip.
    expect((await page(engine, 'scratch/ignored'))!.deleted).toBe(false);
    expect(existsSync(join(root, 'scratch/ignored.md'))).toBe(false);
    expect(await holds(engine)).toEqual([]);
    const census = await censusGitGap(engine, 'default', { sample: 20 });
    expect(census.states).toMatchObject({ database_ahead: 0, git_ahead: 0, undeclared_database_only: 0, worktree_only: 0, unparseable: 0, unsafe_path: 0 });
    expect(census.declared).toMatchObject({ private: 1, git_ignored: 1 });
    const [record] = await engine.executeRaw<{ r: Record<string, unknown> }>("SELECT completed_keys->0 AS r FROM op_checkpoints WHERE op='git-canonical-conversion'");
    expect(record!.r).toMatchObject({ source_id: 'default', to: 'git', preview_hash: preview.preview_hash });

    // A G3 pass afterwards changes nothing.
    const settled = await revisions(engine);
    expect((await performManagedSync(engine, OPTS)).status).toBe('up_to_date');
    expect(await revisions(engine)).toEqual(settled);
    expect(git(root, 'log', '--format=%H', '-1')).toBe(git(root, 'rev-parse', 'HEAD'));
    expect((await planGitConversion(engine, 'default')).preview).toMatchObject({ strict: true, remaining: 0 });
  }, { databaseUrl, setup }), 240_000);

  test('an unknown-side drift whose database body differs from the committed file is a discard, refused by path', () => managedBrain(async brain => {
    const { engine, root } = brain;
    await mixedSource(brain, false);
    const base = git(root, 'rev-parse', 'HEAD');
    const { preview } = await planGitConversion(engine, 'default');
    expect(preview).toMatchObject({ git_wins: { by: { held_drift_unknown: 0 } }, discard: { count: 1, by: { held_drift_unknown_differs: 1 }, sample: ['notes/drift.md'] } });
    await expect(applyGitConversion(engine, 'default', preview.preview_hash, PROCESSING)).rejects.toMatchObject({ code: 'git_conversion_blocked', detail: 'held_drift_unknown_differs' });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(base);
    expect(await strict(engine)).toBe(false);
    expect(await holds(engine)).toEqual(['notes/drift.md file_drift', 'notes/removed.md file_drift']);
    expect((await page(engine, 'notes/drift'))!.body).toContain('Written to the database alone: notes/drift.');
  }, { databaseUrl, setup }), 240_000);

  test('a stale hash refuses preview_changed and writes nothing', () => managedBrain(async brain => {
    const { engine, root } = brain;
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await databaseOnlyEdit(engine, 'notes/ahead', 'Written to the database alone.');
    const base = git(root, 'rev-parse', 'HEAD');
    const preview = await cli(engine, ['default', '--to', 'git']);
    expect(preview).toMatchObject({ status: 'preview', adopt: { count: 1 } });
    const refused = await cli(engine, ['default', '--to', 'git', '--apply', '--expect', 'stale']);
    expect(refused).toMatchObject({ status: 'refused', code: 'preview_changed' });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(base);
    expect(await strict(engine)).toBe(false);
    expect(readFileSync(join(root, 'notes/ahead.md'), 'utf8')).toContain('The committed body of notes/ahead.');
  }, { databaseUrl, setup }), 180_000);

  test('database content that would be discarded refuses by category and writes nothing', () => managedBrain(async brain => {
    const { engine, root } = brain;
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await databaseOnlyEdit(engine, 'notes/ahead', 'Written to the database alone.');
    const edit = note('notes/ahead', 'An uncommitted edit of notes/ahead.');
    writeFileSync(join(root, 'notes/ahead.md'), edit);
    const base = git(root, 'rev-parse', 'HEAD');
    const { preview } = await planGitConversion(engine, 'default');
    expect(preview).toMatchObject({ adopt: { count: 0 }, discard: { count: 1, by: { uncommitted_edit: 1 }, sample: ['notes/ahead.md'] } });
    await expect(applyGitConversion(engine, 'default', preview.preview_hash, PROCESSING)).rejects.toMatchObject({ code: 'git_conversion_blocked', detail: 'uncommitted_edit' });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(base);
    expect(readFileSync(join(root, 'notes/ahead.md'), 'utf8')).toBe(edit);
    expect(await strict(engine)).toBe(false);
    expect((await page(engine, 'notes/ahead'))!.body).toContain('Written to the database alone.');
  }, { databaseUrl, setup }), 180_000);

  test('a crash after a group commit leaves the source non-strict, and a rerun completes once', () => managedBrain(async brain => {
    const { engine, root } = brain;
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await databaseOnlyEdit(engine, 'notes/ahead', 'Written to the database alone.');
    await databaseOnlyPage(brain, 'notes/dbonly', note('notes/dbonly', 'Only in the database.'));
    const base = git(root, 'rev-parse', 'HEAD');
    const first = (await planGitConversion(engine, 'default')).preview;
    installFaultHook(point => { if (point === 'conversion:group_committed') throw new Error('crash after the group commit'); });
    try { await expect(applyGitConversion(engine, 'default', first.preview_hash, PROCESSING)).rejects.toThrow('crash after the group commit'); }
    finally { installFaultHook(undefined); }
    expect(await strict(engine)).toBe(false);
    expect(conversionCommits(root, base)).toHaveLength(1);
    const rerun = (await planGitConversion(engine, 'default')).preview;
    expect(rerun.preview_hash).not.toBe(first.preview_hash);
    expect(rerun).toMatchObject({ adopt: { count: 0 }, discard: { count: 0 } });
    expect(await applyGitConversion(engine, 'default', rerun.preview_hash, PROCESSING)).toMatchObject({ status: 'converted', committed: { pages: 0 } });
    expect(await strict(engine)).toBe(true);
    expect(conversionCommits(root, base)).toEqual([{ subject: 'gbrain: persist 2 canonical memory updates', paths: ['notes/ahead.md', 'notes/dbonly.md'] }]);
    expect(git(root, 'status', '--porcelain')).toBe('');
  }, { databaseUrl, setup }), 180_000);

  test('more pages than one group commit one door commit per group, and the writer lock is free between groups', () => managedBrain(async brain => {
    const { engine, root } = brain;
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(
      "UPDATE pages SET compiled_truth=compiled_truth || ' Edited in the database.', knowledge_revision=gen_random_uuid(), revision_write_request_id=NULL WHERE source_id='default' AND slug LIKE 'bulk/%'"), TEST_WRITE_ATTRIBUTION));
    const base = git(root, 'rev-parse', 'HEAD');
    const { preview } = await planGitConversion(engine, 'default');
    expect(preview).toMatchObject({ adopt: { count: BULK, groups: 2 }, discard: { count: 0 } });
    const { binding } = await resolveManagedSyncContext(engine, { ...OPTS, dryRun: true });
    const free: boolean[] = [];
    installFaultHook(async point => {
      if (point !== 'conversion:group_committed') return;
      const lock = await acquireWorktree(binding, 1_000, undefined, engine, { yieldLanes: true });
      free.push(lock !== null);
      await lock?.release();
    });
    try { expect(await applyGitConversion(engine, 'default', preview.preview_hash, PROCESSING)).toMatchObject({ status: 'converted', committed: { groups: 2, pages: BULK } }); }
    finally { installFaultHook(undefined); }
    expect(free).toEqual([true, true]);
    const commits = conversionCommits(root, base);
    expect(commits.map(commit => [commit.subject, commit.paths.length])).toEqual([
      [`gbrain: persist ${CONVERSION_GROUP_MAX} canonical memory updates`, CONVERSION_GROUP_MAX], ['gbrain: persist canonical memory update', 1]]);
    expect(git(root, 'status', '--porcelain')).toBe('');
  }, { databaseUrl, setup: bulkSetup }), 300_000);

  test('work that lands after the strict-equivalent pass leaves the source strict and reports incomplete', () => managedBrain(async brain => {
    const { engine, root } = brain;
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await databaseOnlyEdit(engine, 'notes/ahead', 'Written to the database alone.');
    const base = git(root, 'rev-parse', 'HEAD');
    const preview = await cli(engine, ['default', '--to', 'git']);
    installFaultHook(async point => { if (point === 'conversion:before_flip') await parkIgnoredEffect(engine, 'notes/same', 'git_target_unsafe'); });
    let result: Record<string, any>;
    try { result = await cli(engine, ['default', '--to', 'git', '--apply', '--expect', preview.preview_hash, '--no-embed', '--no-extract']); }
    finally { installFaultHook(undefined); }
    expect(result).toMatchObject({ status: 'incomplete', code: 'git_conversion_incomplete', result: { status: 'incomplete', committed: { pages: 1 },
      after: { strict: true, remaining: 1, parked_effects: { retry: 1 } } } });
    expect(await strict(engine)).toBe(true);
    expect(conversionCommits(root, base)).toHaveLength(1);
  }, { databaseUrl, setup }), 180_000);

  test('--to mixed removes the flag and nothing else, and converting back commits nothing', () => managedBrain(async brain => {
    const { engine, root } = brain;
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await databaseOnlyEdit(engine, 'notes/ahead', 'Written to the database alone.');
    await applyGitConversion(engine, 'default', (await planGitConversion(engine, 'default')).preview.preview_hash, PROCESSING);
    const head = git(root, 'rev-parse', 'HEAD'), settled = await revisions(engine);
    const mixed = await planMixedConversion(engine, 'default');
    expect(mixed).toMatchObject({ to: 'mixed', strict: true });
    await expect(applyMixedConversion(engine, 'default', 'stale')).rejects.toMatchObject({ code: 'preview_changed' });
    expect(await applyMixedConversion(engine, 'default', mixed.preview_hash)).toEqual({ status: 'mixed', source_id: 'default' });
    expect(await strict(engine)).toBe(false);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(await revisions(engine)).toEqual(settled);
    const back = (await planGitConversion(engine, 'default')).preview;
    expect(back).toMatchObject({ strict: false, adopt: { count: 0 }, git_wins: { count: 0 }, discard: { count: 0 } });
    expect(await applyGitConversion(engine, 'default', back.preview_hash, PROCESSING)).toMatchObject({ status: 'converted', committed: { pages: 0, groups: 0 } });
    expect(await strict(engine)).toBe(true);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
  }, { databaseUrl, setup }), 180_000);

  test('a remote caller cannot convert or run the strict-equivalent pass, and no MCP operation exposes it', () => managedBrain(async ({ engine }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    expect(operations.filter(op => /canonical|conversion/.test(op.name)).map(op => op.name)).toEqual([]);
    const remote = <T>(fn: () => Promise<T>) => withSubmissionAuthority({ version: 1, kind: 'remote_generic' } as never, fn);
    expect(await remote(() => cli(engine, ['default', '--to', 'git']))).toMatchObject({ status: 'refused', code: 'permission_denied', reason: 'trusted_cli_required' });
    await expect(remote(() => resolveManagedSyncContext(engine, { ...OPTS, full: true, canonicalOverride: 'git' }))).rejects.toMatchObject({ code: 'permission_denied' });
    expect(await strict(engine)).toBe(false);
  }, { databaseUrl, setup }), 180_000);

  test('an unmanaged brain refuses strict_requires_managed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-g8a-unmanaged-'));
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
        try {
          expect(await cli(engine, ['default', '--to', 'git'])).toMatchObject({ status: 'refused', code: 'strict_requires_managed' });
          expect(await strict(engine)).toBe(false);
        } finally { await close(); }
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 120_000);
});
