/**
 * scripts/ci-health-report.ts (GBRA-47 V-6, ENG-14): same-repo runs only,
 * first-attempt pass rate, shard spread with the miner command, failing test
 * files from annotations (inert), capped pagination stated as truncation.
 */
import { describe, expect, test } from 'bun:test';
import type { GitHubClient } from '../../scripts/lib/gh-issue.ts';
import { CAPS, collectHealth, firstAttempt, renderHealth, shardRatio, topFailingFiles, type Annotation, type Job, type Run } from '../../scripts/ci-health-report.ts';

const repo = { full_name: 'garrytan/gbrain' };
const run = (id: number, conclusion: string, attempt = 1, fork = false): Run => ({
  id, event: 'pull_request', status: 'completed', conclusion, run_attempt: attempt, created_at: '2026-10-01T00:00:00Z',
  repository: repo, head_repository: fork ? { full_name: 'someone/gbrain' } : repo,
});
const shard = (id: number, name: string, secs: number, conclusion = 'success'): Job => ({
  id, name, conclusion, started_at: '2026-10-01T00:00:00Z', completed_at: new Date(Date.parse('2026-10-01T00:00:00Z') + secs * 1000).toISOString(),
});

describe('ci-health-report', () => {
  test('first-attempt pass counts only runs that passed without a re-run; cancelled runs are ignored', () => {
    expect(firstAttempt([run(1, 'success'), run(2, 'success', 2), run(3, 'failure'), run(4, 'cancelled')])).toEqual({ runs: 3, pass: 1, rate: 1 / 3 });
  });

  test('shard ratio is slowest over mean among matching jobs', () => {
    const jobs = [shard(1, 'test (1)', 100), shard(2, 'test (2)', 200), shard(3, 'verify', 900)];
    expect(shardRatio(jobs, /^test \(\d+\)$/)).toBeCloseTo(200 / 150);
    expect(shardRatio([shard(1, 'test (1)', 100)], /^test \(\d+\)$/)).toBeNull();
  });

  test('failing test files are counted from failure annotations and rendered inert', () => {
    const anns: Annotation[] = [
      { annotation_level: 'failure', path: 'test/a.test.ts', title: 'error: boom @someone https://evil.example', message: 'x' },
      { annotation_level: 'failure', path: 'test/a.test.ts', title: 'error: boom', message: 'x' },
      { annotation_level: 'failure', path: 'test/b.test.ts', message: 'Process completed with exit code 1.' },
      { annotation_level: 'warning', path: 'test/c.test.ts', message: 'Node.js 20 is deprecated' },
      { annotation_level: 'failure', message: 'Process completed with exit code 1.' },
    ];
    const top = topFailingFiles(anns);
    expect(top.map(t => [t.file, t.count])).toEqual([['test/a.test.ts', 2], ['test/b.test.ts', 1]]);
    expect(top[0]!.sample).not.toMatch(/@someone|https:\/\/evil/);
  });

  test('collect reads same-repo runs only, samples jobs and annotations, names the miner command and states truncation', async () => {
    const calls: string[] = [];
    const page = (n: number) => Array.from({ length: n }, (_, i) => run(1000 + i, i % 4 === 0 ? 'failure' : 'success', 1, i % 10 === 9));
    const client: GitHubClient = {
      async request<T>(_m: string, path: string): Promise<T> {
        calls.push(path);
        if (path.includes('/workflows/nightly-watch.yml/runs')) return { workflow_runs: [{ conclusion: 'success', status: 'completed' }] } as T;
        if (path.includes('event=push&status=success')) return { workflow_runs: [{ id: 555 }] } as T;
        if (path.includes('/workflows/test.yml/runs')) return { workflow_runs: page(100) } as T;
        if (path.includes('/workflows/e2e.yml/runs')) return { workflow_runs: page(3) } as T;
        if (path.includes('/jobs')) return { jobs: [shard(1, 'test (1)', 100), shard(2, 'test (2)', 300, 'failure'), shard(3, 'Selected E2E (diff-relevant) 1', 50)] } as T;
        if (path.includes('/annotations')) return [{ annotation_level: 'failure', path: 'test/flaky.test.ts', title: 'error: timeout', message: '' }] as T;
        throw new Error(`unexpected ${path}`);
      },
    };
    const data = await collectHealth(client, '2026-09-27');
    const unit = data.workflows.find(w => w.workflow === 'test.yml')!;
    expect(unit.fork_runs_excluded).toBe(CAPS.runPages * 10);
    expect(unit.runs).toBe(CAPS.runPages * 90);
    expect(unit.miner).toBe('bun run weights:mine --lane unit --run 555');
    expect(unit.spread.mean_ratio).toBeCloseTo(1.5);
    expect(data.truncated.join(' ')).toContain('test.yml: only the newest 300 runs read');
    expect(data.truncated.join(' ')).toContain(`annotations from ${CAPS.failedRunsSampled} of`);
    expect(data.failing_files[0]!.file).toBe('test/flaky.test.ts');
    expect(calls.every(c => !c.includes('/logs'))).toBe(true);
    expect(calls.some(c => c.includes('created=%3E%3D2026-09-27'))).toBe(true);
    const body = renderHealth(data);
    expect(body).toContain('`bun run weights:mine --lane unit --run 555`');
    expect(body).toContain('**Truncated:**');
    expect(body).toContain('### Next step for the agent');
  });
});
