/**
 * `gbrain sources canonical <source-id> --to git|mixed` (git-canonical memory, G8a, docs/designs/GIT_CANONICAL_MEMORY.md#conversion):
 * the one verb that makes a source strict (`config.canonical = "git"`) or returns it to mixed. The default `--dry-run`
 * prints the plan, by category with counts and a capped sample of paths, and its hash; `--apply --expect <hash>` runs it
 * (persistence/git-conversion.ts). Trusted local CLI on a managed brain only; not an MCP operation, since it prints paths.
 */
import type { BrainEngine } from '../core/engine.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { OperationError, opError } from '../core/ops/contract.ts';
import { cliRenderContext, toAgentError } from '../core/agent-output.ts';
import { applyGitConversion, applyMixedConversion, assertConversionCaller, CONVERSION_GROUP_MAX, planGitConversion, planMixedConversion,
  type GitConversionPreview, type GitConversionResult, type MixedConversionPreview } from '../core/persistence/git-conversion.ts';

const USAGE = 'Usage: gbrain sources canonical <source-id> --to git|mixed [--dry-run | --apply --expect <hash> [--no-embed] [--no-extract]] [--json]';
const DOCS = 'docs/designs/GIT_CANONICAL_MEMORY.md#conversion';

export function parseCanonicalArgs(args: string[]): { sourceId: string; to: 'git' | 'mixed'; apply: boolean; expect: string | null; json: boolean; noEmbed: boolean; noExtract: boolean } {
  const positional: string[] = [];
  let to: string | null = null, expect: string | null = null, apply = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--to') { to = args[++i] ?? null; continue; }
    if (arg === '--expect') { expect = args[++i] ?? null; if (!expect) throw new OperationError('invalid_params', '--expect needs the preview hash.', USAGE); continue; }
    if (arg === '--apply') { apply = true; continue; }
    if (arg === '--dry-run' || arg === '--json' || arg === '--no-embed' || arg === '--no-extract') continue;
    if (arg.startsWith('-')) throw new OperationError('invalid_params', `Unknown sources canonical flag: ${arg}.`, USAGE);
    positional.push(arg);
  }
  if (positional.length !== 1) throw new OperationError('invalid_params', 'sources canonical needs exactly one source id.', USAGE);
  if (to !== 'git' && to !== 'mixed') throw new OperationError('invalid_params', `--to needs git or mixed; got ${to ?? 'nothing'}.`, USAGE);
  if (apply && args.includes('--dry-run')) throw new OperationError('invalid_params', '--apply and --dry-run exclude each other.', USAGE);
  if (apply && !expect) throw new OperationError('invalid_params', '--apply needs --expect <hash> from the --dry-run preview.', USAGE);
  return { sourceId: positional[0]!, to, apply, expect, json: args.includes('--json'), noEmbed: args.includes('--no-embed'), noExtract: args.includes('--no-extract') };
}

const counts = (record: Record<string, number>) => Object.entries(record).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
const sample = (paths: string[]) => paths.map(path => `    ${path}`);

export function describeGitPreview(p: GitConversionPreview): string {
  const lines = [`Source ${p.source_id}${p.strict ? ' (already git-canonical)' : ''} at ${p.head?.slice(0, 12) ?? 'no commit'}: ${p.pages} live page(s), ${p.equal} equal to HEAD.`,
    `Adopt (write the database's page to its file and commit it through the door, ${p.adopt.groups} commit(s) of up to ${CONVERSION_GROUP_MAX}): ${p.adopt.count} (${counts(p.adopt.by)}).`, ...sample(p.adopt.sample),
    `Declared database-only (nothing written, nothing deleted): ${p.declared.count} (${counts(p.declared.by)}).`,
    `Git wins (the strict pass indexes the committed file): ${p.git_wins.count} (${counts(p.git_wins.by)}).`, ...sample(p.git_wins.sample),
    `Holds cleared so Git's verdict runs: ${p.holds.count} (${counts(p.holds.by)}).`,
    `Parked effects: ${p.parked_effects.count} (retry ${p.parked_effects.retry}, reclassify as declared ${p.parked_effects.reclassify}; ${counts(p.parked_effects.by_code)}).`,
    `The strict pass also imports ${p.index.imports} and deletes ${p.index.deletes} page(s) where the database holds nothing Git lacks.`,
    `Database content that would be discarded: ${p.discard.count}${p.discard.count ? ` (${counts(p.discard.by)}); the apply refuses until it is 0` : ''}.`, ...sample(p.discard.sample)];
  lines.push(p.remaining === 0 && p.strict ? 'Nothing is left to convert.' : `Nothing changed. To apply: ${p.apply.join(' ')}`);
  return lines.join('\n');
}

function describeResult(r: GitConversionResult): string {
  const lines = [`Source ${r.source_id} ${r.status === 'converted' ? 'is git-canonical' : 'is git-canonical, with work left'}: ${r.committed.pages} page(s) committed in ${r.committed.groups} door commit(s), ${r.holds_cleared} hold(s) cleared, ${r.parked.retried} parked effect(s) retried and ${r.parked.reclassified} reclassified.`];
  if (r.status === 'incomplete') lines.push(describeGitPreview(r.after));
  return lines.join('\n');
}

function describeMixed(p: MixedConversionPreview): string {
  return p.strict ? `Source ${p.source_id} is git-canonical; --to mixed removes canonical: git and changes nothing else (Git keeps every door commit).\nNothing changed. To apply: ${p.apply.join(' ')}`
    : `Source ${p.source_id} is not git-canonical; there is nothing to change.`;
}

export async function runSourcesCanonical(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  if (args.includes('--help') || args.includes('-h')) { console.log(`${USAGE}\nPreview first: lists, by category, what converting the source to git-canonical (or back) does (${DOCS}).`); return; }
  const print = (value: unknown, text: string) => console.log(json ? JSON.stringify(value) : text);
  try {
    const parsed = parseCanonicalArgs(args);
    await assertConversionCaller(engine, parsed.sourceId);
    if (parsed.to === 'mixed') {
      if (!parsed.apply) { const { incarnation: _, ...preview } = await planMixedConversion(engine, parsed.sourceId); print(preview, describeMixed(preview)); return; }
      const done = await applyMixedConversion(engine, parsed.sourceId, parsed.expect!);
      print(done, done.status === 'mixed' ? `Source ${parsed.sourceId} is mixed: canonical: git removed.` : `Source ${parsed.sourceId} was not git-canonical; nothing changed.`);
      return;
    }
    if (!parsed.apply) { const { preview } = await planGitConversion(engine, parsed.sourceId); print(preview, describeGitPreview(preview)); return; }
    const result = await applyGitConversion(engine, parsed.sourceId, parsed.expect!, { noEmbed: parsed.noEmbed, noExtract: parsed.noExtract });
    if (result.status === 'incomplete') {
      const error = opError('git_conversion_incomplete', `Source ${parsed.sourceId} is git-canonical, and ${result.after.remaining} item(s) were still open after its strict pass.`,
        `Writes landed during the conversion. Git wins on the source now; preview again with gbrain sources canonical ${parsed.sourceId} --to git --dry-run and apply the new hash.`,
        { docs: DOCS, detail: 'work_left' });
      print({ status: 'incomplete', result, ...toAgentError(error, { transport: 'cli', command: 'sources canonical', render: cliRenderContext() }) }, describeResult(result));
      setCliExitVerdict(1);
      return;
    }
    print(result, describeResult(result));
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    const env = toAgentError(error, { transport: 'cli', command: 'sources canonical', render: cliRenderContext() });
    console.log(json ? JSON.stringify({ status: 'refused', ...env }) : `Conversion refused (${error.code}): ${error.message}\nFix: ${error.suggestion ?? USAGE}`);
    setCliExitVerdict(1);
  }
}
