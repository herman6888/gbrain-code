#!/usr/bin/env bun
/**
 * Weekly CI health report (GBRA-47 V-6, ENG-14).
 *
 *   bun scripts/ci-health-report.ts [--days 7] [--repo owner/name] [--dry-run]
 *
 * Reads the last N days of same-repository pull-request runs of test.yml and
 * e2e.yml through the REST API (runs, jobs and check-run annotations only;
 * never logs, never fork runs or fork artifacts) and upserts one issue titled
 * `CI health (week of <date>)` (label `ci-health`) with:
 *
 * - first-attempt pass rate per workflow (a run that needed a re-run failed
 *   its first attempt);
 * - the test files with the most failure annotations across failed runs;
 * - unit and Selected E2E shard spread (slowest shard / mean, per run) with
 *   the weights miner command when it passes 1.25;
 * - serial files added in the window (`*.serial.test.ts`, from git history);
 * - nightly-watch's own latest status.
 *
 * API calls are capped (pages of runs, failed runs sampled for annotations,
 * runs sampled for shard spread); any cap that truncated data is stated in
 * the issue. --dry-run reads only and prints the issue.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { commentIssue, createIssue, ensureLabel, findIssueByTitle, inert, jsonBlock, restClient, updateIssue, type GitHubClient } from './lib/gh-issue.ts';

const ROOT = resolve(import.meta.dir, '..');
export const LABEL = 'ci-health';
export const SPREAD_LIMIT = 1.25;
export const CAPS = { runPages: 3, failedRunsSampled: 15, spreadRunsSampled: 10 };
const WORKFLOWS = [
  { file: 'test.yml', shard: /^test \(\d+\)$/, lane: 'unit' },
  { file: 'e2e.yml', shard: /^Selected E2E \(diff-relevant\)/, lane: 'e2e' },
] as const;

export interface Run {
  id: number;
  event: string;
  status: string;
  conclusion: string | null;
  run_attempt: number;
  created_at: string;
  head_repository?: { full_name: string } | null;
  repository?: { full_name: string };
}
export interface Job { id: number; name: string; conclusion: string | null; started_at?: string | null; completed_at?: string | null }
export interface Annotation { annotation_level: string; path?: string; title?: string | null; message: string }

export interface WorkflowHealth {
  workflow: string;
  runs: number;
  fork_runs_excluded: number;
  first_attempt_pass: number;
  first_attempt_rate: number | null;
  spread: { runs: number; mean_ratio: number | null; worst_ratio: number | null };
  miner: string | null;
}
export interface HealthData {
  since: string;
  workflows: WorkflowHealth[];
  failing_files: Array<{ file: string; count: number; sample: string }>;
  serial_added: string[] | null;
  serial_total: number;
  nightly_watch: string;
  truncated: string[];
}

export function sameRepo(run: Run): boolean {
  return !run.head_repository || !run.repository || run.head_repository.full_name === run.repository.full_name;
}

export function firstAttempt(runs: Run[]): { runs: number; pass: number; rate: number | null } {
  const done = runs.filter(r => r.status === 'completed' && r.conclusion !== 'cancelled' && r.conclusion !== 'skipped');
  const pass = done.filter(r => r.conclusion === 'success' && r.run_attempt === 1).length;
  return { runs: done.length, pass, rate: done.length ? pass / done.length : null };
}

/** Slowest shard / mean shard duration for one run's shard jobs; null under two timed shards. */
export function shardRatio(jobs: Job[], shard: RegExp): number | null {
  const secs = jobs.filter(j => shard.test(j.name) && j.started_at && j.completed_at)
    .map(j => (Date.parse(j.completed_at!) - Date.parse(j.started_at!)) / 1000).filter(s => s > 0);
  if (secs.length < 2) return null;
  const mean = secs.reduce((a, b) => a + b, 0) / secs.length;
  return Math.max(...secs) / mean;
}

export function topFailingFiles(annotations: Annotation[], limit = 10): HealthData['failing_files'] {
  const counts = new Map<string, { count: number; sample: string }>();
  for (const a of annotations) {
    if (a.annotation_level !== 'failure' || !a.path || !/\.test\.ts$/.test(a.path)) continue;
    const entry = counts.get(a.path) ?? { count: 0, sample: inert(a.title || a.message, 160) };
    entry.count++;
    counts.set(a.path, entry);
  }
  return [...counts].map(([file, v]) => ({ file: inert(file, 160), ...v })).sort((a, b) => b.count - a.count || a.file.localeCompare(b.file)).slice(0, limit);
}

export function serialFiles(dir = join(ROOT, 'test')): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...serialFiles(path));
    else if (name.endsWith('.serial.test.ts')) out.push(relative(ROOT, path));
  }
  return out.sort();
}

/** Serial test files added since the date, or null when the clone is shallow (history unknown). */
export function serialAddedSince(since: string): string[] | null {
  const shallow = Bun.spawnSync(['git', 'rev-parse', '--is-shallow-repository'], { cwd: ROOT, stdout: 'pipe' }).stdout.toString().trim();
  if (shallow !== 'false') return null;
  const r = Bun.spawnSync(['git', 'log', `--since=${since}`, '--diff-filter=A', '--name-only', '--format=', '--', '*.serial.test.ts'], { cwd: ROOT, stdout: 'pipe' });
  return [...new Set(r.stdout.toString().split('\n').filter(Boolean))].sort();
}

const pct = (n: number | null) => (n === null ? 'n/a' : `${Math.round(n * 100)}%`);
const ratio = (n: number | null) => (n === null ? 'n/a' : n.toFixed(2));

export function renderHealth(data: HealthData): string {
  const steps: string[] = [];
  for (const f of data.failing_files.slice(0, 3)) steps.push(`Fix the flake or regression in \`${f.file}\` (${f.count} failure annotations this week); reproduce with \`bun test --timeout=60000 ${f.file}\`.`);
  for (const w of data.workflows) {
    if (w.miner && (w.spread.mean_ratio ?? 0) > SPREAD_LIMIT) steps.push(`Shards in ${w.workflow} are unbalanced (mean slowest/mean ${ratio(w.spread.mean_ratio)} > ${SPREAD_LIMIT}): \`${w.miner}\`, then commit the weights.`);
  }
  if (data.serial_added?.length) steps.push(`Review the ${data.serial_added.length} new serial file(s) below: each needs a reason it cannot run in parallel (\`bash scripts/check-test-isolation.sh <file>\`).`);
  if (data.nightly_watch !== 'success') steps.push(`nightly-watch's latest run is \`${inert(data.nightly_watch, 40)}\`: read it with \`gh run list --workflow nightly-watch.yml --limit 3\` before trusting nightly issues.`);
  const lines = [
    `Same-repository pull-request runs since ${data.since}.`,
    '',
    '| workflow | completed runs | first-attempt pass | shard spread (mean / worst slowest-to-mean) | fork runs not read |',
    '|---|---|---|---|---|',
    ...data.workflows.map(w => `| ${w.workflow} | ${w.runs} | ${w.first_attempt_pass} (${pct(w.first_attempt_rate)}) | ${ratio(w.spread.mean_ratio)} / ${ratio(w.spread.worst_ratio)} over ${w.spread.runs} runs | ${w.fork_runs_excluded} |`),
    '',
    '**Most failure annotations by test file** (failed runs sampled):',
    ...(data.failing_files.length ? data.failing_files.map(f => `- \`${f.file}\`: ${f.count} (e.g. \`${f.sample}\`)`) : ['- none']),
    '',
    `**Serial files:** ${data.serial_total} total; added in the window: ${data.serial_added === null ? 'unknown (shallow clone; the workflow checks out full history)'
      : data.serial_added.length ? `${data.serial_added.slice(0, 20).map(f => `\`${inert(f)}\``).join(', ')}${data.serial_added.length > 20 ? ` and ${data.serial_added.length - 20} more` : ''}` : 'none'}.`,
    `**nightly-watch latest run:** ${inert(data.nightly_watch, 40)}.`,
    ...(data.truncated.length ? ['', `**Truncated:** ${data.truncated.join('; ')}.`] : []),
    '',
    '### Next step for the agent',
    '',
    ...(steps.length ? steps.map((s, i) => `${i + 1}. ${s}`) : ['Nothing to do this week.']),
    '',
    jsonBlock('ci-health:json', data),
    '',
  ];
  return lines.join('\n');
}

export async function collectHealth(client: GitHubClient, since: string): Promise<HealthData> {
  const truncated: string[] = [];
  const workflows: WorkflowHealth[] = [];
  const annotations: Annotation[] = [];
  for (const wf of WORKFLOWS) {
    const runs: Run[] = [];
    for (let page = 1; page <= CAPS.runPages; page++) {
      const r = await client.request<{ workflow_runs: Run[] }>('GET', `repos/{repo}/actions/workflows/${wf.file}/runs?event=pull_request&created=${encodeURIComponent(`>=${since}`)}&per_page=100&page=${page}`);
      runs.push(...r.workflow_runs);
      if (r.workflow_runs.length < 100) break;
      if (page === CAPS.runPages) truncated.push(`${wf.file}: only the newest ${CAPS.runPages * 100} runs read`);
    }
    const mine = runs.filter(sameRepo);
    const fa = firstAttempt(mine);
    const failed = mine.filter(r => r.conclusion === 'failure' || r.run_attempt > 1);
    if (failed.length > CAPS.failedRunsSampled) truncated.push(`${wf.file}: annotations from ${CAPS.failedRunsSampled} of ${failed.length} failed runs`);
    const spreadRuns = mine.filter(r => r.conclusion === 'success').slice(0, CAPS.spreadRunsSampled);
    const ratios: number[] = [];
    const jobsOf = (run: Run, attempt: number) => client.request<{ jobs: Job[] }>('GET', `repos/{repo}/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100`).then(r => r.jobs);
    for (const run of spreadRuns) {
      const r = shardRatio(await jobsOf(run, run.run_attempt), wf.shard);
      if (r !== null) ratios.push(r);
    }
    for (const run of failed.slice(0, CAPS.failedRunsSampled)) {
      const jobs = await jobsOf(run, 1);
      for (const job of jobs.filter(j => j.conclusion === 'failure').slice(0, 3)) {
        annotations.push(...await client.request<Annotation[]>('GET', `repos/{repo}/check-runs/${job.id}/annotations?per_page=50`).catch(() => []));
      }
    }
    const latestGreen = await client.request<{ workflow_runs: Array<{ id: number }> }>('GET', `repos/{repo}/actions/workflows/${wf.file}/runs?event=push&status=success&per_page=1`)
      .catch(() => ({ workflow_runs: [] }));
    const greenId = latestGreen.workflow_runs[0]?.id;
    workflows.push({
      workflow: wf.file,
      runs: fa.runs,
      fork_runs_excluded: runs.length - mine.length,
      first_attempt_pass: fa.pass,
      first_attempt_rate: fa.rate,
      spread: { runs: ratios.length, mean_ratio: ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null, worst_ratio: ratios.length ? Math.max(...ratios) : null },
      miner: greenId ? `bun run weights:mine --lane ${wf.lane} --run ${greenId}` : null,
    });
  }
  const watch = await client.request<{ workflow_runs: Array<{ conclusion: string | null; status: string }> }>('GET', 'repos/{repo}/actions/workflows/nightly-watch.yml/runs?per_page=1')
    .catch(() => ({ workflow_runs: [] }));
  const latest = watch.workflow_runs[0];
  return {
    since,
    workflows,
    failing_files: topFailingFiles(annotations),
    serial_added: serialAddedSince(since),
    serial_total: serialFiles().length,
    nightly_watch: latest ? (latest.conclusion ?? latest.status) : 'no runs yet',
    truncated,
  };
}

if (import.meta.main) {
  const flag = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
  const days = Number(flag('--days') ?? 7);
  const repo = flag('--repo') ?? process.env.GITHUB_REPOSITORY ?? 'garrytan/gbrain';
  const dryRun = process.argv.includes('--dry-run');
  if (!Number.isInteger(days) || days < 1 || days > 31) {
    console.log('Usage: bun scripts/ci-health-report.ts [--days 1-31] [--repo owner/name] [--dry-run]');
    process.exit(2);
  }
  const now = new Date();
  const since = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  try {
    const client = restClient(repo);
    const data = await collectHealth(client, since);
    const body = renderHealth(data);
    const title = `CI health (week of ${since})`;
    if (dryRun) {
      console.log(`--- title: ${title}\n--- body:\n${body}`);
      process.exit(0);
    }
    await ensureLabel(client, LABEL, '0e8a16', 'Weekly CI health report (scripts/ci-health-report.ts)');
    const existing = await findIssueByTitle(client, LABEL, title);
    if (existing) {
      await updateIssue(client, existing.number, { body, state: 'open' });
      await commentIssue(client, existing.number, 'Report refreshed.');
      console.log(`[ci-health] updated #${existing.number}`);
    } else {
      console.log(`[ci-health] opened #${(await createIssue(client, title, body, [LABEL])).number}`);
    }
  } catch (e) {
    console.log(`[ci-health] FAIL: ${e instanceof Error ? e.message : String(e)}`);
    console.log('[ci-health] Fix: check the token scopes (actions:read, checks:read, issues:write) and rerun: bun scripts/ci-health-report.ts --dry-run');
    process.exit(1);
  }
}
