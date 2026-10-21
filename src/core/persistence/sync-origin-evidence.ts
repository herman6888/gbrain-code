/**
 * #7130: whether a missing file is evidence that its page was deleted. A managed sync deletes a live page whose recorded
 * file is absent from the pinned tree and the disk only when Git once committed that file: then its absence is a removal
 * the history records, and the page's bytes stay recoverable from the commit that held them. A file Git never committed
 * (an agent's write-through that landed in a directory `.gitignore` excludes, a copy removed before any commit) left no
 * history, so its absence proves nothing and the page may hold the only copy of its content: sync holds it instead.
 *
 * Both reads are bounded Git plumbing over the candidate paths alone. A read that fails or times out answers `unknown`
 * for every path it covered, which the classifier treats like a missing commit (fail closed: hold, never delete).
 */
import { execFile, spawn } from '../spawn.ts';
import { promisify } from 'node:util';
import { gitChildEnv } from '../git-env.ts';

const execFileAsync = promisify(execFile);

/** `committed`: some commit of the history holds the path. `never_committed`: none does. `ignored`: none does and `.gitignore` excludes it (a commit's evidence wins over a later ignore rule). `unknown`: a read failed. */
export type OriginEvidence = 'committed' | 'never_committed' | 'ignored' | 'unknown';

/** Paths per Git invocation (argument-list bound). */
const BATCH = 500;
const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 64 * 1024 ** 2;

/** `literal`: the paths are pathspecs read literally (`log`); `check-ignore` takes plain pathnames and refuses the magic. */
async function git(gitRoot: string, args: string[], literal = false): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await execFileAsync('git', ['-c', 'core.quotepath=false', ...(literal ? ['--literal-pathspecs'] : []), '-C', gitRoot, ...args],
      { env: gitChildEnv(), encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER });
    return { code: 0, stdout };
  } catch (error) {
    const e = error as { code?: unknown; stdout?: unknown; killed?: boolean };
    return { code: typeof e.code === 'number' && !e.killed ? e.code : -1, stdout: typeof e.stdout === 'string' ? e.stdout : '' };
  }
}

/** `git check-ignore --no-index -z --stdin` over `paths` (NUL-separated both ways, so any byte in a name survives). */
function checkIgnore(gitRoot: string, paths: readonly string[]): Promise<{ code: number; stdout: string }> {
  return new Promise(resolve => {
    const child = spawn('git', ['-c', 'core.quotepath=false', '-C', gitRoot, 'check-ignore', '--no-index', '-z', '--stdin'], { env: gitChildEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let size = 0, settled = false;
    const done = (code: number) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code, stdout: Buffer.concat(chunks).toString('utf8') }); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(-1); }, GIT_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > GIT_MAX_BUFFER) { child.kill('SIGKILL'); done(-1); } else chunks.push(chunk); });
    child.on('error', () => done(-1));
    child.on('close', code => done(code ?? -1));
    child.stdin.on('error', () => undefined);
    child.stdin.end(paths.map(path => `${path}\0`).join(''));
  });
}

/**
 * #7130 (write-through): whether the Git work tree around `root` ignores `relativePath` and does not track it, so a
 * file written there would never be committed. False outside a work tree or when Git cannot answer (the write keeps its
 * old behavior then; sync's own evidence read still fails closed).
 */
export async function gitIgnoresUntracked(root: string, relativePath: string): Promise<boolean> {
  return (await git(root, ['check-ignore', '-q', '--', relativePath])).code === 0;
}

/**
 * The evidence for each Git-root-relative path in `gitPaths`, read in the work tree at `gitRoot`. `commits` are the
 * history tips to search (the pinned target and the pass's baseline); a path any commit reachable from one of them
 * touched was committed. `.gitignore` is read as the checkout has it now.
 */
export async function readOriginEvidence(gitRoot: string, commits: ReadonlyArray<string | null | undefined>, gitPaths: readonly string[]): Promise<Map<string, OriginEvidence>> {
  const evidence = new Map<string, OriginEvidence>();
  const tips = [...new Set(commits.filter((commit): commit is string => typeof commit === 'string' && commit.length > 0))];
  const paths = [...new Set(gitPaths)];
  for (let i = 0; i < paths.length; i += BATCH) {
    const batch = paths.slice(i, i + BATCH);
    const touched = tips.length ? await git(gitRoot, ['log', ...tips, '--format=', '--name-only', '--no-renames', '-z', '--', ...batch], true) : { code: 0, stdout: '' };
    // With an empty format and -z, every name is one NUL-terminated record (no separator between commits): read each byte for byte.
    const committed = new Set(touched.stdout.split('\0').filter(Boolean));
    const ignoredRead = await checkIgnore(gitRoot, batch);
    const ignored = new Set(ignoredRead.stdout.split('\0').filter(Boolean));
    // check-ignore exits 1 when no path is ignored; anything else but 0 is a failed read.
    const ignoreKnown = ignoredRead.code === 0 || ignoredRead.code === 1;
    for (const path of batch) {
      if (touched.code !== 0 || !ignoreKnown) evidence.set(path, 'unknown');
      else if (committed.has(path)) evidence.set(path, 'committed');
      else evidence.set(path, ignored.has(path) ? 'ignored' : 'never_committed');
    }
  }
  return evidence;
}
