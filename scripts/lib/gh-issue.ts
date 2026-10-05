/**
 * Shared GitHub issue helpers for the CI watchers (scripts/nightly-issue.ts,
 * scripts/ci-health-report.ts).
 *
 * - `inert()` makes a run-derived string (job, step and test names, error
 *   text) safe to show an agent: control characters stripped, length capped,
 *   backticks and pipes replaced, `@` mentions and links neutralised, so the
 *   text renders as data and never pings, links or breaks out of a fence.
 * - `GitHubClient` is the one seam both scripts call; tests pass a recorded
 *   fake, production uses `restClient()` (fetch + GH_TOKEN/GITHUB_TOKEN in
 *   Actions, or the authenticated `gh api` CLI for local dry runs).
 * - `findIssueByTitle` looks an issue up through the list API by label and
 *   exact title (open first, else the most recently updated closed one, so a
 *   flapping workflow reopens its own issue).
 */

export interface GitHubClient {
  request<T = unknown>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T>;
}

export interface Issue {
  number: number;
  title: string;
  state: 'open' | 'closed';
  body?: string | null;
  labels?: Array<{ name: string } | string>;
  updated_at?: string;
  pull_request?: unknown;
}

const ZWSP = '\u200b';

export function inert(value: unknown, max = 200): string {
  let s = String(value ?? '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\r?\n/g, ' ')
    .replace(/`/g, "'")
    .replace(/\|/g, '/')
    .replace(/@/g, `@${ZWSP}`)
    .replace(/:\/\//g, `:${ZWSP}//`)
    .replace(/\bwww\./gi, m => `${m.slice(0, 3)}${ZWSP}.`)
    .replace(/[<>]/g, c => (c === '<' ? '‹' : '›'))
    .trim();
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s;
}

/** Multi-line run-derived text for a `~~~text` fence: same neutralisation, newlines kept, fences broken. */
export function inertBlock(value: unknown, max = 1500): string {
  const lines = String(value ?? '').split(/\r?\n/).map(line => inert(line, 400).replace(/~{3,}/g, '~ ~ ~'));
  let s = lines.join('\n');
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s;
}

/** Production client: REST with GH_TOKEN/GITHUB_TOKEN (Actions), else the authenticated `gh api` CLI (local dry runs). */
export function restClient(repo: string, token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN): GitHubClient {
  const resolve = (path: string) => path.replace('{repo}', repo).replace(/^\//, '');
  if (!token) return ghCliClient(resolve);
  return {
    async request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
      const url = `https://api.github.com/${resolve(path)}`;
      const res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw Object.assign(new Error(`GitHub API ${method} ${url} -> ${res.status}: ${text.slice(0, 300)}`), { status: res.status });
      }
      return (res.status === 204 ? undefined : await res.json()) as T;
    },
  };
}

function ghCliClient(resolve: (path: string) => string): GitHubClient {
  return {
    async request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
      const args = ['gh', 'api', '-X', method, resolve(path), ...(body === undefined ? [] : ['--input', '-'])];
      const r = Bun.spawnSync(args, { stdin: body === undefined ? 'ignore' : Buffer.from(JSON.stringify(body)), stdout: 'pipe', stderr: 'pipe' });
      if (r.exitCode !== 0) {
        const err = `${r.stderr.toString()} ${r.stdout.toString()}`.trim();
        const status = Number(/HTTP (\d{3})/.exec(err)?.[1]) || undefined;
        throw Object.assign(new Error(`gh api ${method} ${resolve(path)} failed: ${err.slice(0, 300)}. Fix: gh auth login, or export GH_TOKEN.`), { status });
      }
      const out = r.stdout.toString().trim();
      return (out ? JSON.parse(out) : undefined) as T;
    },
  };
}

/** Create a label unless it exists (422 = already there). */
export async function ensureLabel(client: GitHubClient, name: string, color: string, description: string): Promise<void> {
  try {
    await client.request('POST', 'repos/{repo}/labels', { name, color, description });
  } catch (e) {
    if ((e as { status?: number }).status !== 422) throw e;
  }
}

export async function findIssueByTitle(client: GitHubClient, label: string, title: string, maxPages = 3): Promise<Issue | undefined> {
  const matches: Issue[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = await client.request<Issue[]>('GET', `repos/{repo}/issues?labels=${encodeURIComponent(label)}&state=all&sort=updated&direction=desc&per_page=100&page=${page}`);
    matches.push(...batch.filter(i => !i.pull_request && i.title === title));
    if (batch.length < 100) break;
  }
  return matches.find(i => i.state === 'open') ?? matches[0];
}

export const labelNames = (issue: Issue): string[] => (issue.labels ?? []).map(l => (typeof l === 'string' ? l : l.name));

export async function createIssue(client: GitHubClient, title: string, body: string, labels: string[]): Promise<Issue> {
  return client.request<Issue>('POST', 'repos/{repo}/issues', { title, body, labels });
}

export async function updateIssue(client: GitHubClient, number: number, patch: { body?: string; state?: 'open' | 'closed'; labels?: string[] }): Promise<Issue> {
  return client.request<Issue>('PATCH', `repos/{repo}/issues/${number}`, patch);
}

export async function commentIssue(client: GitHubClient, number: number, body: string): Promise<void> {
  await client.request('POST', `repos/{repo}/issues/${number}/comments`, { body });
}

/** Extract the fenced JSON block a watcher wrote between its markers; undefined when absent or not valid JSON. */
export function readJsonBlock<T>(body: string | null | undefined, marker: string): T | undefined {
  const text = body ?? '';
  const tag = `<!-- ${marker} -->`;
  const at = text.indexOf(tag);
  if (at === -1) return undefined;
  const rest = text.slice(at + tag.length).trimStart();
  const open = '```json\n';
  if (!rest.startsWith(open)) return undefined;
  const end = rest.indexOf('\n```', open.length - 1);
  if (end === -1) return undefined;
  try { return JSON.parse(rest.slice(open.length, end)) as T; } catch { return undefined; }
}

export function jsonBlock(marker: string, value: unknown): string {
  return `<!-- ${marker} -->\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}
