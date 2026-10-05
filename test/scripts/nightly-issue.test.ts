/**
 * scripts/nightly-issue.ts + scripts/lib/gh-issue.ts over recorded GitHub API
 * JSON (Heavy Tests scheduled run 37195155240, red; macOS 26 validation
 * scheduled run 37197810506, green): open, update, flap-reopen, skip-green
 * stays open, close, known-red signatures, review-by, injection, TSV
 * validation and the "every scheduled workflow is watched" ratchet.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeLoad } from 'js-yaml';
import { inert, readJsonBlock, type GitHubClient, type Issue } from '../../scripts/lib/gh-issue.ts';
import {
  JSON_MARKER, parseKnownRed, validateKnownRed, watchRun, type IncidentRecord, type JobInfo, type KnownRow, type RunInfo,
} from '../../scripts/nightly-issue.ts';

const ROOT = join(import.meta.dir, '../..');
const FIX = join(ROOT, 'test/fixtures/nightly-watch');
const load = <T>(name: string): T => JSON.parse(readFileSync(join(FIX, name), 'utf8')) as T;
const REPO = 'garrytan/gbrain';
const TODAY = '2026-10-05';

interface Call { method: string; path: string; body?: Record<string, unknown> }

function fakeClient(opts: { run: RunInfo; jobs: { jobs: JobInfo[]; total_count: number }; annotations?: Record<number, unknown[]>; issues?: Issue[] }) {
  const calls: Call[] = [];
  const client: GitHubClient = {
    async request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
      calls.push({ method, path, body: body as Record<string, unknown> });
      if (method !== 'GET') {
        if (path === 'repos/{repo}/issues') return { number: 101, title: (body as { title: string }).title, state: 'open' } as T;
        return {} as T;
      }
      if (/actions\/runs\/\d+$/.test(path)) return opts.run as T;
      if (path.includes('/jobs?')) return opts.jobs as T;
      const ann = /check-runs\/(\d+)\/annotations/.exec(path);
      if (ann) return (opts.annotations?.[Number(ann[1])] ?? []) as T;
      if (path.includes('/runs?event=schedule&status=success')) return { workflow_runs: [{ head_sha: 'a'.repeat(40) }] } as T;
      if (path.includes('/issues?labels=')) return (opts.issues ?? []) as T;
      throw new Error(`unexpected GET ${path}`);
    },
  };
  return { client, calls };
}

const heavy = () => ({
  run: load<RunInfo>('run-heavy.json'),
  jobs: load<{ jobs: JobInfo[]; total_count: number }>('jobs-heavy.json'),
  annotations: Object.fromEntries([111415376248, 111415376292, 111415376359].map(id => [id, load<unknown[]>(`annotations-${id}.json`)])),
});
const realRows = parseKnownRed(readFileSync(join(ROOT, '.github/nightly-known-red.tsv'), 'utf8')).rows;
const hermesRow: KnownRow = { workflow: 'Heavy Tests', job: 'Hermes door e2e (credentialed, real binary, loud-fail)', signature: 'Run hermes door tests', kind: 'known-skipped', todo: 'PR time to green', review_by: '2026-10-25' };
const scaleRow: KnownRow = { workflow: 'Scale tier', job: 'scale pglite 20000', signature: 'phase watchdog: vectors', kind: 'known-red', todo: 'PGLite bulk-embedding cost at 20k+ chunks', review_by: '2026-10-25' };
const scaleRows = [...realRows, scaleRow];
const recordOf = (body: unknown) => readJsonBlock<IncidentRecord>(String(body), JSON_MARKER)!;
const issueWith = (state: 'open' | 'closed', record: Partial<IncidentRecord>, labels = ['nightly-red']): Issue => ({
  number: 7, title: 'Nightly red: Heavy Tests', state, labels: labels.map(name => ({ name })),
  body: `old\n<!-- ${JSON_MARKER} -->\n\`\`\`json\n${JSON.stringify(record)}\n\`\`\``,
});

describe('nightly-watch incidents', () => {
  test('a red scheduled run with no issue opens one with job/step pairs, the next step and a JSON block', async () => {
    const { client, calls } = fakeClient(heavy());
    const { plan, assessment } = await watchRun({ client, repo: REPO, runId: 37195155240, rows: realRows, today: TODAY, dryRun: false });
    expect(assessment.state).toBe('red');
    expect(plan.action).toBe('create');
    const create = calls.find(c => c.method === 'POST' && c.path === 'repos/{repo}/issues')!;
    expect(create.body!.title).toBe('Nightly red: Heavy Tests');
    expect(create.body!.labels).toEqual(['nightly-red']);
    const body = String(create.body!.body);
    expect(body).toContain('| `Heavy tests` | `Bootstrap offline Docker e2e (placeholder)` | failure | no |');
    expect(body).toContain('### Next step for the agent');
    expect(body).toContain('owner action');
    expect(body).toContain('https://github.com/garrytan/gbrain/compare/');
    const record = recordOf(body);
    expect(record.failing.map(f => f.job).sort()).toEqual(['Heavy tests', 'Hermes door e2e (credentialed, real binary, loud-fail)', 'Plugin doors (codex + claude, install tier)']);
    expect(record.first_red).toEqual({ run_id: 37195155240, sha: record.head_sha });
    expect(record.dispatch_argv).toEqual(['gh', 'workflow', 'run', 'heavy-tests.yml', '--ref', 'master']);
    expect(record.next_step).toBe('code_fix');
    expect(calls.filter(c => c.path === 'repos/{repo}/labels').map(c => c.body!.name)).toEqual(['nightly-red']);
  });

  test('an open incident with the same failing set is updated without a comment; a changed set comments; first red is kept', async () => {
    const first = fakeClient(heavy());
    const created = await watchRun({ client: first.client, repo: REPO, runId: 1, rows: realRows, today: TODAY, dryRun: true });
    const same = issueWith('open', { ...created.plan.record!, first_red: { run_id: 42, sha: 'f'.repeat(40) } });
    const again = fakeClient({ ...heavy(), issues: [same] });
    const updated = await watchRun({ client: again.client, repo: REPO, runId: 1, rows: realRows, today: TODAY, dryRun: false });
    expect(updated.plan.action).toBe('update');
    expect(again.calls.some(c => c.path.endsWith('/comments'))).toBe(false);
    const patch = again.calls.find(c => c.method === 'PATCH')!;
    expect(recordOf(patch.body!.body).first_red.run_id).toBe(42);

    const changed = fakeClient({ ...heavy(), issues: [issueWith('open', { ...created.plan.record!, failing: [] })] });
    await watchRun({ client: changed.client, repo: REPO, runId: 1, rows: realRows, today: TODAY, dryRun: false });
    expect(String(changed.calls.find(c => c.path.endsWith('/comments'))!.body!.body)).toContain('Failing set changed');
  });

  test('a closed incident that goes red again reopens with the run attempt (flap)', async () => {
    const { client, calls } = fakeClient({ ...heavy(), issues: [issueWith('closed', { failing: [] })] });
    const { plan } = await watchRun({ client, repo: REPO, runId: 1, rows: realRows, today: TODAY, dryRun: false });
    expect(plan.action).toBe('reopen');
    expect(calls.find(c => c.method === 'PATCH')!.body!.state).toBe('open');
    const comment = String(calls.find(c => c.path.endsWith('/comments'))!.body!.body);
    expect(comment).toContain('flap');
    expect(comment).toContain('attempt 1');
    expect(recordOf(calls.find(c => c.method === 'PATCH')!.body!.body).first_red.run_id).toBe(37195155240);
  });

  test('a green run closes only when the previously failing jobs executed; a skipped job keeps it open', async () => {
    const green = { run: load<RunInfo>('run-macos-green.json'), jobs: load<{ jobs: JobInfo[]; total_count: number }>('jobs-macos-green.json') };
    const fixed = fakeClient({ ...green, issues: [{ ...issueWith('open', { failing: [{ job: 'macOS 26 validation', job_id: 1, step: 's', errors: [] }] }), title: 'Nightly red: macOS 26 validation' }] });
    const closed = await watchRun({ client: fixed.client, repo: REPO, runId: 1, rows: realRows, today: TODAY, dryRun: false });
    expect(closed.plan.action).toBe('close');
    expect(fixed.calls.find(c => c.method === 'PATCH')!.body!.state).toBe('closed');

    const skipped = fakeClient({ ...green, issues: [{ ...issueWith('open', { failing: [{ job: 'macOS codesign', job_id: 1, step: 's', errors: [] }] }), title: 'Nightly red: macOS 26 validation' }] });
    const kept = await watchRun({ client: skipped.client, repo: REPO, runId: 1, rows: realRows, today: TODAY, dryRun: false });
    expect(kept.plan.action).toBe('none');
    expect(skipped.calls.some(c => c.method === 'PATCH')).toBe(false);
    expect(String(skipped.calls.find(c => c.path.endsWith('/comments'))!.body!.body)).toContain('did not execute and pass');
  });

  const scaleRun = (message: string) => ({
    run: { ...load<RunInfo>('run-heavy.json'), name: 'Scale tier', path: '.github/workflows/scale-tier.yml' },
    jobs: { total_count: 2, jobs: [
      { id: 1, name: 'scale pglite 20000', conclusion: 'failure', steps: [{ number: 7, name: 'Scale tier (pglite, 20000 pages, enforce)', conclusion: 'failure' }] },
      { id: 2, name: 'scale postgres 20000', conclusion: 'success', steps: [] },
    ] },
    annotations: { 1: [{ annotation_level: 'failure', title: 'Scale phase watchdog', message }] },
  });

  test('a failure matching a known-red row is tracked (known-red label, no comment when unchanged); new error text in the same job is a new incident', async () => {
    const watchdog = '[scale] FAIL phase watchdog: vectors ran 676 s, limit 675 s; the harness was killed (exit 1).';
    const first = fakeClient(scaleRun(watchdog));
    const known = await watchRun({ client: first.client, repo: REPO, runId: 1, rows: scaleRows, today: TODAY, dryRun: false });
    expect(known.assessment.state).toBe('known-red');
    expect(known.plan.labels).toEqual(['nightly-red', 'known-red']);
    expect(known.plan.record!.next_step).toBe('known_red_wait');
    expect(known.plan.record!.dispatch_argv).toEqual(['gh', 'workflow', 'run', 'scale-tier.yml', '--ref', 'master', '-f', 'pages=20000']);

    const unchanged = fakeClient({ ...scaleRun(watchdog), issues: [{ ...issueWith('open', known.plan.record!, ['nightly-red', 'known-red']), title: 'Nightly red: Scale tier' }] });
    await watchRun({ client: unchanged.client, repo: REPO, runId: 1, rows: scaleRows, today: TODAY, dryRun: false });
    expect(unchanged.calls.some(c => c.path.endsWith('/comments'))).toBe(false);

    const other = fakeClient(scaleRun('[scale] FAIL find_orphans: an island page is missing'));
    const fresh = await watchRun({ client: other.client, repo: REPO, runId: 1, rows: scaleRows, today: TODAY, dryRun: false });
    expect(fresh.assessment.state).toBe('red');
    expect(fresh.plan.labels).toEqual(['nightly-red']);
  });

  test('a passed review-by date asks for a fix once, then stays quiet', async () => {
    const watchdog = '[scale] FAIL phase watchdog: vectors ran 676 s';
    const late = '2026-11-01';
    const first = fakeClient(scaleRun(watchdog));
    const created = await watchRun({ client: first.client, repo: REPO, runId: 1, rows: scaleRows, today: late, dryRun: false });
    expect(created.plan.record!.next_step).toBe('review_by_passed');
    const before = { ...created.plan.record!, review_by_notified: [] };
    const open = fakeClient({ ...scaleRun(watchdog), issues: [{ ...issueWith('open', before, ['nightly-red', 'known-red']), title: 'Nightly red: Scale tier' }] });
    const notified = await watchRun({ client: open.client, repo: REPO, runId: 1, rows: scaleRows, today: late, dryRun: false });
    expect(String(open.calls.find(c => c.path.endsWith('/comments'))!.body!.body)).toContain('Review-by date passed');
    const quiet = fakeClient({ ...scaleRun(watchdog), issues: [{ ...issueWith('open', notified.plan.record!, ['nightly-red', 'known-red']), title: 'Nightly red: Scale tier' }] });
    await watchRun({ client: quiet.client, repo: REPO, runId: 1, rows: scaleRows, today: late, dryRun: false });
    expect(quiet.calls.some(c => c.path.endsWith('/comments'))).toBe(false);
  });

  test('a known-skipped row (the keyless Hermes leg) keeps the run from reading green: the run is not green and the issue stays open with an owner action', async () => {
    const h = heavy();
    const jobs = h.jobs.jobs.map(j => j.name.startsWith('Hermes') ? { ...j, conclusion: 'success', steps: j.steps!.map(s => ({ ...s, conclusion: s.name === 'Run hermes door tests' ? 'skipped' : 'success' })) }
      : { ...j, conclusion: j.conclusion === 'failure' ? 'success' : j.conclusion });
    const { client } = fakeClient({ ...h, jobs: { ...h.jobs, jobs } });
    const { assessment, plan } = await watchRun({ client, repo: REPO, runId: 1, rows: [...realRows, hermesRow], today: TODAY, dryRun: true });
    expect(assessment.state).toBe('known-skipped');
    expect(plan.action).toBe('create');
    expect(plan.record!.next_step).toBe('owner_action');
    expect(plan.body).toContain('This run is not green coverage.');
  });

  test('run-derived text is inert: no mention, no link, no fence break', async () => {
    const hostile = 'shard @attacker see https://evil.example/x ```\n</details> | `rm -rf ~`';
    const h = heavy();
    const jobs = h.jobs.jobs.map(j => (j.id === 111415376248 ? { ...j, name: hostile } : j));
    const annotations = { ...h.annotations, 111415376248: [{ annotation_level: 'failure', message: `boom @maintainer [click](https://evil.example)\n~~~\n\`\`\`` }] };
    const { client } = fakeClient({ ...h, jobs: { ...h.jobs, jobs }, annotations });
    const { plan } = await watchRun({ client, repo: REPO, runId: 1, rows: realRows, today: TODAY, dryRun: true });
    const body = plan.body!;
    expect(body).not.toMatch(/@attacker|@maintainer/);
    expect(body).not.toContain('https://evil');
    expect(body).not.toContain('`rm -rf ~`');
    expect(body).not.toContain('</details>');
    expect((body.match(/^~~~/gm) ?? []).length % 2).toBe(0);
    expect((body.match(/^```/gm) ?? []).length).toBe(2);
    expect(recordOf(body).failing.some(f => f.job.includes(`@\u200battacker`))).toBe(true);
    expect(inert('a'.repeat(500), 50)).toHaveLength(50);
  });

  test('fork runs are never read; non-scheduled runs are refused unless previewed', async () => {
    const forked = fakeClient({ ...heavy(), run: { ...load<RunInfo>('run-heavy.json'), head_repository: { full_name: 'someone/fork' } } });
    await expect(watchRun({ client: forked.client, repo: REPO, runId: 1, rows: realRows, today: TODAY, dryRun: true })).rejects.toThrow('fork');
    const pushed = fakeClient({ ...heavy(), run: { ...load<RunInfo>('run-heavy.json'), event: 'push' } });
    await expect(watchRun({ client: pushed.client, repo: REPO, runId: 1, rows: realRows, today: TODAY, dryRun: false })).rejects.toThrow('only tracks scheduled runs');
  });
});

describe('.github/nightly-known-red.tsv', () => {
  const todos = readFileSync(join(ROOT, 'TODOS.md'), 'utf8');
  const header = '# Columns: workflow, job, signature, kind, todo, review_by\n';
  const row = (r: Partial<KnownRow> = {}) => [r.workflow ?? 'W', r.job ?? 'j', r.signature ?? 's', r.kind ?? 'known-red', r.todo ?? 'Set the ANTHROPIC_API_KEY and OPENAI_API_KEY repo secrets', r.review_by ?? '2026-10-25'].join('\t');

  test('the committed file is valid: at most 3 rows, ISO review-by dates, each TODO present in TODOS.md', () => {
    expect(validateKnownRed(readFileSync(join(ROOT, '.github/nightly-known-red.tsv'), 'utf8'), todos)).toEqual([]);
    expect(readFileSync(join(ROOT, 'docs/RELEASING.md'), 'utf8')).toContain('\n## Nightly-red issues\n');
  });

  test('a fourth row, a bad date, an unknown kind or a missing TODO is refused with the fix', () => {
    const four = header + [row(), row({ job: 'a' }), row({ job: 'b' }), row({ job: 'c' })].join('\n');
    expect(validateKnownRed(four, todos).join('\n')).toContain('at most 3 cells');
    expect(validateKnownRed(header + row({ review_by: '10/25/2026' }), todos).join('\n')).toContain('ISO date');
    expect(validateKnownRed(header + row({ kind: 'flaky' as KnownRow['kind'] }), todos).join('\n')).toContain('known-red or known-skipped');
    const missing = validateKnownRed(header + row({ todo: 'No such TODO' }), todos);
    expect(missing.join('\n')).toContain('is not in TODOS.md');
    expect(missing[0]).toContain('Fix: ');
    expect(missing[0]).toContain('Docs: docs/RELEASING.md#nightly-red-issues');
  });
});

describe('nightly-watch coverage ratchet', () => {
  test('every workflow with a schedule trigger is watched', () => {
    const dir = join(ROOT, '.github/workflows');
    const watch = safeLoad(readFileSync(join(dir, 'nightly-watch.yml'), 'utf8')) as { on: { workflow_run: { workflows: string[] } } };
    const scheduled = readdirSync(dir).filter(f => f.endsWith('.yml')).map(f => safeLoad(readFileSync(join(dir, f), 'utf8')) as { name: string; on?: { schedule?: unknown } })
      .filter(w => w.on && typeof w.on === 'object' && 'schedule' in w.on).map(w => w.name);
    expect(scheduled.length).toBeGreaterThan(5);
    const missing = scheduled.filter(name => !watch.on.workflow_run.workflows.includes(name));
    expect(missing, `Add ${missing.join(', ')} to .github/workflows/nightly-watch.yml on.workflow_run.workflows`).toEqual([]);
  });
});
