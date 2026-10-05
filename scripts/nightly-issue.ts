#!/usr/bin/env bun
/**
 * Nightly-red incident upkeep (GBRA-47 A1; X1, V-5, DX-15, ENG-14, ENG-15).
 *
 *   bun scripts/nightly-issue.ts --run-id <id> [--repo owner/name] [--dry-run]
 *
 * Reads one completed scheduled workflow run (run, jobs, the failing jobs'
 * check-run annotations, the workflow's last green scheduled run) and keeps
 * one GitHub issue per workflow titled `Nightly red: <workflow>` (label
 * `nightly-red`): opens it on a red run, updates it while red, reopens it on
 * a flap (recording the run attempt), and closes it only when a later
 * scheduled run is green AND every previously failing job executed and
 * passed (a skipped job never closes an incident).
 *
 * `.github/nightly-known-red.tsv` (at most 3 rows) lists known-red and
 * known-skipped cells. A run whose only problems match rows keeps the issue
 * open with the `known-red` label and comments only when the failing set
 * changes or a row's review-by date passes. A new failure inside a listed job
 * (different step or error text) is a new incident.
 *
 * Everything that comes from the run (job, step and test names, error text)
 * passes through inert(): no mentions, no links, no fence breaks. The issue
 * body ends with a fenced JSON block for agents; the next step names who
 * acts (owner_action vs code_fix).
 *
 * --dry-run reads only and prints the action and the issue body it would
 * write. Exit 0 on any verdict; 1 when the run or the TSV cannot be read
 * (the error says why and how to fix it); 2 usage error.
 */
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  commentIssue, createIssue, ensureLabel, findIssueByTitle, inert, inertBlock, jsonBlock, labelNames, readJsonBlock, restClient, updateIssue,
  type GitHubClient, type Issue,
} from './lib/gh-issue.ts';

const REPO_ROOT = resolve(import.meta.dir, '..');
export const KNOWN_RED_FILE = '.github/nightly-known-red.tsv';
export const KNOWN_RED_MAX = 3;
export const LABEL = 'nightly-red';
export const KNOWN_LABEL = 'known-red';
export const JSON_MARKER = 'nightly-watch:json';
export const DOCS = 'docs/RELEASING.md#nightly-red-issues';

export interface RunInfo {
  id: number;
  name: string;
  event: string;
  conclusion: string | null;
  run_attempt: number;
  path: string;
  workflow_id: number;
  head_branch: string;
  head_sha: string;
  html_url: string;
  head_repository?: { full_name: string };
  repository?: { full_name: string };
}
export interface JobInfo {
  id: number;
  name: string;
  conclusion: string | null;
  html_url?: string;
  steps?: Array<{ number: number; name: string; conclusion: string | null }>;
}
export interface Annotation { annotation_level: string; title?: string | null; message: string }
export interface KnownRow { workflow: string; job: string; signature: string; kind: 'known-red' | 'known-skipped'; todo: string; review_by: string }
export interface Failure { job: string; job_id: number; job_url?: string; conclusion: string; step: string; errors: string[] }
export interface Assessment {
  state: 'green' | 'red' | 'known-red' | 'known-skipped';
  failures: Failure[];
  unmatched: Failure[];
  matched: Array<{ row: KnownRow; failure?: Failure }>;
  stale: KnownRow[];
  reviewPassed: KnownRow[];
}
export interface IncidentRecord {
  workflow: string;
  workflow_file: string;
  state: Assessment['state'];
  run_id: number;
  run_attempt: number;
  run_url: string;
  head_sha: string;
  failing: Array<{ job: string; job_id: number; step: string; errors: string[] }>;
  known: Array<{ job: string; signature: string; kind: string; todo: string; review_by: string }>;
  first_red: { run_id: number; sha: string };
  last_green_sha: string | null;
  dispatch_argv: string[];
  next_step: 'code_fix' | 'owner_action' | 'known_red_wait' | 'review_by_passed' | 'none';
  review_by_notified?: string[];
}
export interface Plan {
  action: 'create' | 'update' | 'reopen' | 'close' | 'none';
  title: string;
  labels: string[];
  body?: string;
  comment?: string;
  issue?: number;
  record?: IncidentRecord;
  reason: string;
}

const FAILING = new Set(['failure', 'timed_out', 'cancelled', 'startup_failure']);
const GENERIC_ERROR = /^Process completed with exit code \d+\.?$/;
const OWNER_SIGNAL = /gh secret set|secret is empty|secrets? (?:is |are )?(?:empty|missing|not configured)/i;

export function parseKnownRed(text: string): { rows: KnownRow[]; problems: string[] } {
  const rows: KnownRow[] = [];
  const problems: string[] = [];
  text.split('\n').forEach((line, i) => {
    if (!line.trim() || line.startsWith('#')) return;
    const cols = line.split('\t');
    if (cols.length !== 6 || cols.some(c => !c.trim())) {
      problems.push(`line ${i + 1}: expected 6 non-empty tab-separated columns (workflow, job, signature, kind, todo, review_by), got ${cols.length}`);
      return;
    }
    const [workflow, job, signature, kind, todo, review_by] = cols.map(c => c.trim()) as [string, string, string, string, string, string];
    if (kind !== 'known-red' && kind !== 'known-skipped') problems.push(`line ${i + 1}: kind must be known-red or known-skipped, got '${kind}'`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(review_by) || Number.isNaN(Date.parse(`${review_by}T00:00:00Z`))) problems.push(`line ${i + 1}: review_by must be an ISO date (YYYY-MM-DD), got '${review_by}'`);
    rows.push({ workflow, job, signature, kind: kind as KnownRow['kind'], todo, review_by });
  });
  if (rows.length > KNOWN_RED_MAX) problems.push(`${rows.length} rows; at most ${KNOWN_RED_MAX} cells may be known-red at once (fix one before adding another)`);
  return { rows, problems };
}

/** Problems that make the TSV invalid; each says how to fix it. */
export function validateKnownRed(text: string, todosText: string): string[] {
  const { rows, problems } = parseKnownRed(text);
  for (const row of rows) {
    if (!todosText.includes(row.todo)) problems.push(`row '${row.job}': todo '${row.todo}' is not in TODOS.md; every known-red row needs the TODO that owns its fix`);
  }
  return problems.map(p => `${KNOWN_RED_FILE}: ${p}. Fix: edit the row, then run bun test --timeout=60000 test/scripts/nightly-issue.test.ts. Docs: ${DOCS}`);
}

export function assessRun(run: RunInfo, jobs: JobInfo[], annotations: Record<number, Annotation[]>, rows: KnownRow[], today: string): Assessment {
  const failures: Failure[] = jobs.filter(j => FAILING.has(j.conclusion ?? '')).map(j => {
    const step = j.steps?.find(s => FAILING.has(s.conclusion ?? ''));
    const errors = (annotations[j.id] ?? []).filter(a => a.annotation_level === 'failure' && !GENERIC_ERROR.test(a.message.trim()))
      .map(a => [a.title, a.message].filter(Boolean).join(': '));
    return { job: j.name, job_id: j.id, job_url: j.html_url, conclusion: j.conclusion!, step: step?.name ?? '(job-level)', errors };
  });
  const mine = rows.filter(r => r.workflow === run.name);
  const matched: Assessment['matched'] = [];
  const stale: KnownRow[] = [];
  const unmatched = failures.filter(f => {
    const row = mine.find(r => r.kind === 'known-red' && r.job === f.job && (f.step.includes(r.signature) || f.errors.some(e => e.includes(r.signature))));
    if (row) matched.push({ row, failure: f });
    return !row;
  });
  for (const row of mine) {
    const job = jobs.find(j => j.name === row.job);
    if (row.kind === 'known-skipped') {
      const step = job?.steps?.find(s => s.name === row.signature);
      if (step?.conclusion === 'skipped') matched.push({ row });
      else if (job && step) stale.push(row);
    } else if (!matched.some(m => m.row === row) && job?.conclusion === 'success') {
      stale.push(row);
    }
  }
  const reviewPassed = matched.map(m => m.row).filter(r => r.review_by < today);
  const state: Assessment['state'] = unmatched.length ? 'red'
    : matched.some(m => m.row.kind === 'known-red') ? 'known-red'
      : matched.length ? 'known-skipped' : 'green';
  return { state, failures, unmatched, matched, stale, reviewPassed };
}

export function dispatchArgv(run: RunInfo, failures: Failure[]): string[] {
  const argv = ['gh', 'workflow', 'run', basename(run.path), '--ref', run.head_branch];
  if (basename(run.path) === 'scale-tier.yml') {
    const pages = failures.map(f => /\b(\d{4,})$/.exec(f.job)?.[1]).find(Boolean);
    if (pages) argv.push('-f', `pages=${pages}`);
  }
  return argv;
}

const failingKey = (rec: Pick<IncidentRecord, 'failing'> | undefined) => (rec?.failing ?? []).map(f => `${f.job} > ${f.step} > ${f.errors.join(' / ')}`).sort().join('\n');

function nextStepText(rec: IncidentRecord, assessment: Assessment): string {
  const dispatch = `\`${rec.dispatch_argv.join(' ')}\``;
  switch (rec.next_step) {
    case 'owner_action':
      return `**Owner action (not a code fix).** A repository setting only the owner can change is missing (see the errors above, e.g. an empty secret). `
        + `Ask the repo owner to apply the named fix (\`gh secret set <NAME>\`), then re-check with ${dispatch}. Do not open a code PR for this.`;
    case 'known_red_wait':
      return `**Known red, tracked.** The failing cells match \`${KNOWN_RED_FILE}\` rows owned by TODOS.md entries (listed above). `
        + `No action until the review-by date; a new failure in the same job opens a new incident.`;
    case 'review_by_passed':
      return `**Review-by date passed** for: ${assessment.reviewPassed.map(r => `\`${inert(r.job)}\` (${r.review_by}, TODO: ${inert(r.todo)})`).join('; ')}. `
        + `Fix the cell and delete its row, or re-justify the row with a new date in a reviewed PR. Docs: ${DOCS}`;
    case 'code_fix': {
      const owner = assessment.unmatched.filter(f => OWNER_SIGNAL.test(f.errors.join(' ')));
      return `**Code fix.** Read the failing step log (\`gh run view ${rec.run_id} --log-failed\`), reproduce it locally with the owning workflow's command, `
        + `then within 24 hours open a repair PR or add a \`${KNOWN_RED_FILE}\` row (at most ${KNOWN_RED_MAX}) with a P1 TODO. Re-check with ${dispatch}. Docs: ${DOCS}`
        + (owner.length ? `\n\nAlso an **owner action** (not a code fix) for ${owner.map(f => `\`${inert(f.job)}\``).join(', ')}: ask the repo owner to apply the fix its error names.` : '');
    }
    default:
      return 'None.';
  }
}

export function renderBody(rec: IncidentRecord, assessment: Assessment): string {
  const lines = [
    `Workflow **${inert(rec.workflow)}** (\`${rec.workflow_file}\`) — state: **${rec.state}**.`,
    '',
    `- Latest scheduled run: ${rec.run_url} (attempt ${rec.run_attempt}, \`${rec.head_sha.slice(0, 12)}\`)`,
    `- First red run of this incident: https://github.com/{repo}/actions/runs/${rec.first_red.run_id} (\`${rec.first_red.sha.slice(0, 12)}\`)`,
    `- Last green scheduled run SHA: ${rec.last_green_sha ? `\`${rec.last_green_sha.slice(0, 12)}\`; commits since: https://github.com/{repo}/compare/${rec.last_green_sha}...${rec.head_sha}` : 'none found'}`,
    `- Re-check: \`${rec.dispatch_argv.join(' ')}\``,
    `- Owner: the agent on release duty (Garry escalates); respond within 24 hours with a repair PR or a known-red row. Docs: ${DOCS}`,
    '',
  ];
  if (assessment.failures.length) {
    lines.push('| job | step | result | tracked |', '|---|---|---|---|');
    for (const f of assessment.failures) {
      const row = assessment.matched.find(m => m.failure === f)?.row;
      lines.push(`| \`${inert(f.job)}\` | \`${inert(f.step)}\` | ${inert(f.conclusion, 20)} | ${row ? `known-red (TODO: ${inert(row.todo)}, review by ${row.review_by})` : 'no'} |`);
    }
    lines.push('');
    for (const f of assessment.failures.filter(x => x.errors.length)) {
      lines.push(`Errors in \`${inert(f.job)}\`:`, '~~~text', inertBlock(f.errors.slice(0, 3).join('\n')), '~~~', '');
    }
  }
  for (const m of assessment.matched.filter(x => x.row.kind === 'known-skipped')) {
    lines.push(`- Known-skipped: \`${inert(m.row.job)}\` step \`${inert(m.row.signature)}\` did not run (TODO: ${inert(m.row.todo)}, review by ${m.row.review_by}). This run is not green coverage.`);
  }
  for (const r of assessment.stale) {
    lines.push(`- Stale row: \`${inert(r.job)}\` / \`${inert(r.signature)}\` no longer matches (the cell ran). Delete it from \`${KNOWN_RED_FILE}\`.`);
  }
  lines.push('', '### Next step for the agent', '', nextStepText(rec, assessment), '', jsonBlock(JSON_MARKER, rec), '');
  return lines.join('\n');
}

export function planIncident(run: RunInfo, assessment: Assessment, existing: Issue | undefined, lastGreenSha: string | null, repo: string, succeededJobs: string[]): Plan {
  const title = `Nightly red: ${inert(run.name, 100)}`;
  const previous = existing ? readJsonBlock<IncidentRecord>(existing.body, JSON_MARKER) : undefined;
  const keepLabels = existing ? labelNames(existing).filter(l => l !== KNOWN_LABEL && l !== LABEL) : [];
  const runUrl = `https://github.com/${repo}/actions/runs/${run.id}`;

  if (assessment.state === 'green') {
    if (!existing || existing.state === 'closed') return { action: 'none', title, labels: [], reason: 'green and no open incident' };
    const prevJobs = [...new Set((previous?.failing ?? []).map(f => f.job))];
    const notRun = prevJobs.filter(job => !succeededJobs.some(s => inert(s) === job));
    if (notRun.length) {
      return {
        action: 'none', title, labels: [], issue: existing.number,
        comment: `Run ${runUrl} is green, but previously failing job(s) did not execute and pass: ${notRun.map(j => `\`${inert(j)}\``).join(', ')}. `
          + 'Keeping this incident open; a skipped job is not a fix.',
        reason: 'green but previously failing jobs did not run',
      };
    }
    return {
      action: 'close', title, labels: [], issue: existing.number,
      comment: `Green: scheduled run ${runUrl} (attempt ${run.run_attempt}) passed and every previously failing job executed. Closing.`,
      reason: 'green and previously failing jobs passed',
    };
  }

  const reopening = existing?.state === 'closed';
  const continuing = existing?.state === 'open' && previous;
  const notified = continuing ? previous!.review_by_notified ?? [] : [];
  const newlyPassed = assessment.reviewPassed.filter(r => !notified.includes(`${r.job}|${r.review_by}`));
  const record: IncidentRecord = {
    workflow: inert(run.name, 100),
    workflow_file: run.path,
    state: assessment.state,
    run_id: run.id,
    run_attempt: run.run_attempt,
    run_url: runUrl,
    head_sha: run.head_sha,
    failing: assessment.failures.map(f => ({ job: inert(f.job), job_id: f.job_id, step: inert(f.step), errors: f.errors.slice(0, 3).map(e => inert(e, 400)) })),
    known: assessment.matched.map(m => ({ job: inert(m.row.job), signature: inert(m.row.signature), kind: m.row.kind, todo: inert(m.row.todo), review_by: m.row.review_by })),
    first_red: continuing ? previous!.first_red : { run_id: run.id, sha: run.head_sha },
    last_green_sha: lastGreenSha,
    dispatch_argv: dispatchArgv(run, assessment.failures),
    next_step: assessment.state === 'red'
      ? (assessment.unmatched.every(f => OWNER_SIGNAL.test(f.errors.join(' '))) ? 'owner_action' : 'code_fix')
      : assessment.reviewPassed.length ? 'review_by_passed'
        : assessment.state === 'known-skipped' ? 'owner_action' : 'known_red_wait',
    review_by_notified: [...notified, ...newlyPassed.map(r => `${r.job}|${r.review_by}`)],
  };
  const body = renderBody(record, assessment).replaceAll('{repo}', repo);
  const labels = [LABEL, ...(assessment.state === 'red' ? [] : [KNOWN_LABEL]), ...keepLabels];

  if (!existing) return { action: 'create', title, labels, body, record, reason: `new ${assessment.state} incident` };
  if (reopening) {
    return {
      action: 'reopen', title, labels, body, record, issue: existing.number,
      comment: `Red again (flap): scheduled run ${runUrl}, attempt ${run.run_attempt}, state ${assessment.state}. Reopening; the body has the failing jobs and the next step.`,
      reason: 'closed incident is red again',
    };
  }
  const changed = failingKey(previous) !== failingKey(record) || previous?.state !== record.state;
  const comment = changed
    ? `Failing set changed in scheduled run ${runUrl} (attempt ${run.run_attempt}); state ${record.state}. See the updated body.`
    : newlyPassed.length
      ? `Review-by date passed for ${newlyPassed.map(r => `\`${inert(r.job)}\``).join(', ')}: fix the cell or re-justify its row with a new date.`
      : undefined;
  return { action: 'update', title, labels, body, record, issue: existing.number, comment, reason: changed ? 'failing set changed' : 'same failing set' };
}

async function pagedJobs(client: GitHubClient, run: RunInfo): Promise<JobInfo[]> {
  const jobs: JobInfo[] = [];
  for (let page = 1; page <= 5; page++) {
    const r = await client.request<{ jobs: JobInfo[]; total_count: number }>('GET', `repos/{repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`);
    jobs.push(...r.jobs);
    if (jobs.length >= r.total_count || r.jobs.length < 100) break;
  }
  return jobs;
}

export interface WatchResult { plan: Plan; assessment: Assessment; run: RunInfo }

export async function watchRun(opts: { client: GitHubClient; repo: string; runId: number; rows: KnownRow[]; today: string; dryRun: boolean }): Promise<WatchResult> {
  const { client, repo } = opts;
  const run = await client.request<RunInfo>('GET', `repos/{repo}/actions/runs/${opts.runId}`);
  if (run.head_repository?.full_name && run.repository?.full_name && run.head_repository.full_name !== run.repository.full_name) {
    throw new Error(`run ${run.id} comes from fork ${run.head_repository.full_name}; nightly-watch never reads fork runs.`);
  }
  if (run.event !== 'schedule' && !opts.dryRun) {
    throw new Error(`run ${run.id} is a ${run.event} run; nightly-watch only tracks scheduled runs. Fix: pass a scheduled run id, or add --dry-run to preview.`);
  }
  const jobs = await pagedJobs(client, run);
  const annotations: Record<number, Annotation[]> = {};
  for (const job of jobs.filter(j => FAILING.has(j.conclusion ?? ''))) {
    annotations[job.id] = await client.request<Annotation[]>('GET', `repos/{repo}/check-runs/${job.id}/annotations?per_page=50`).catch(() => []);
  }
  const assessment = assessRun(run, jobs, annotations, opts.rows, opts.today);
  const greens = await client.request<{ workflow_runs: Array<{ head_sha: string }> }>('GET',
    `repos/{repo}/actions/workflows/${run.workflow_id}/runs?event=schedule&status=success&per_page=1`).catch(() => ({ workflow_runs: [] }));
  const existing = await findIssueByTitle(client, LABEL, `Nightly red: ${inert(run.name, 100)}`);
  const succeeded = jobs.filter(j => j.conclusion === 'success').map(j => j.name);
  const plan = planIncident(run, assessment, existing, greens.workflow_runs[0]?.head_sha ?? null, repo, succeeded);
  if (opts.dryRun) return { plan, assessment, run };

  if (plan.action === 'create' || plan.action === 'reopen' || plan.action === 'update') {
    await ensureLabel(client, LABEL, 'b60205', 'A scheduled workflow is red (nightly-watch)');
    if (plan.labels.includes(KNOWN_LABEL)) await ensureLabel(client, KNOWN_LABEL, 'fbca04', 'Red or skipped on a tracked .github/nightly-known-red.tsv row');
  }
  if (plan.action === 'create') {
    plan.issue = (await createIssue(client, plan.title, plan.body!, plan.labels)).number;
  } else if (plan.action === 'reopen' || plan.action === 'update') {
    await updateIssue(client, plan.issue!, { body: plan.body, labels: plan.labels, ...(plan.action === 'reopen' ? { state: 'open' as const } : {}) });
  }
  if (plan.comment && plan.issue) await commentIssue(client, plan.issue, plan.comment);
  if (plan.action === 'close') await updateIssue(client, plan.issue!, { state: 'closed' });
  return { plan, assessment, run };
}

if (import.meta.main) {
  const flag = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
  const runId = Number(flag('--run-id'));
  const repo = flag('--repo') ?? process.env.GITHUB_REPOSITORY ?? 'garrytan/gbrain';
  const dryRun = process.argv.includes('--dry-run');
  if (!Number.isInteger(runId) || runId <= 0) {
    console.log('Usage: bun scripts/nightly-issue.ts --run-id <id> [--repo owner/name] [--dry-run]');
    process.exit(2);
  }
  try {
    const tsv = readFileSync(join(REPO_ROOT, KNOWN_RED_FILE), 'utf8');
    const problems = validateKnownRed(tsv, readFileSync(join(REPO_ROOT, 'TODOS.md'), 'utf8'));
    for (const p of problems) console.log(`::warning::${p}`);
    const { rows } = parseKnownRed(tsv);
    const today = new Date().toISOString().slice(0, 10);
    const { plan, assessment, run } = await watchRun({ client: restClient(repo), repo, runId, rows, today, dryRun });
    console.log(`[nightly-watch] ${run.name} run ${run.id} attempt ${run.run_attempt}: ${assessment.state}; action ${plan.action}${plan.issue ? ` #${plan.issue}` : ''} (${plan.reason})${dryRun ? ' [dry run]' : ''}`);
    if (dryRun) {
      console.log(`--- title: ${plan.title}\n--- labels: ${plan.labels.join(', ') || '(none)'}`);
      if (plan.comment) console.log(`--- comment:\n${plan.comment}`);
      if (plan.body) console.log(`--- body:\n${plan.body}`);
    }
  } catch (e) {
    console.log(`[nightly-watch] FAIL: ${e instanceof Error ? e.message : String(e)}`);
    console.log(`[nightly-watch] Fix: check the run id and the token's actions:read / issues:write scopes, then rerun: bun scripts/nightly-issue.ts --run-id ${runId} --dry-run. Docs: ${DOCS}`);
    process.exit(1);
  }
}
