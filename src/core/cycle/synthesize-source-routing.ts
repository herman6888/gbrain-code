/**
 * #7805: dream synthesis writes a captured session's pages to the session's own
 * source, the one #6268 froze for it, never to the cycle's source.
 *
 * Every corpus file resolves through `resolveCorpusFileSource`, the resolver the
 * facts sweep uses (sweep.ts, "#6268 source fidelity"): a spool file's stamp, or
 * its session's frozen record (an unresolved record with a cwd is frozen first,
 * from the brain's resolution chain, exactly as the sweep does), and a top-level
 * legacy file only with durable evidence of its source. A file of the cycle's
 * source is synthesized; a file of another source is skipped
 * (`corpus_source_other`) and synthesizes when the phase runs for that source; a
 * file with no evidence of its source is held with the resolver's reason. Nothing
 * falls back to the cycle's source. Files outside the session corpus (the meeting
 * transcripts dir, an `--input` file elsewhere) and imported conversation pages
 * (read from the cycle's source) are not session captures and pass unchanged.
 * extract_atoms routes its session-corpus transcripts through the same two
 * functions (#7846).
 */
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import { corpusSpoolDir } from '../context/corpus-segments.ts';
import { resolveCorpusFileSource } from '../context/corpus-source.ts';
import { CONVERSATION_PAGE_URI_PREFIX, type DiscoveredTranscript } from './transcript-discovery.ts';

export interface SessionSourceRouting {
  /** Corpus files of other sources (`corpus_source_other`), counted by the source each belongs to. */
  corpus_source_other: Record<string, number>;
  /** Corpus files with no evidence of their source, counted by the resolver's hold reason. */
  held: Record<string, number>;
}

export const emptySessionSourceRouting = (): SessionSourceRouting => ({ corpus_source_other: {}, held: {} });

function corpusLocation(filePath: string, corpusDir: string): 'spool' | 'legacy' | null {
  const root = resolve(corpusDir);
  const file = resolve(filePath);
  const rel = relative(root, file);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return null;
  return dirname(file) === resolve(corpusSpoolDir(root)) ? 'spool' : 'legacy';
}

/** The transcripts this cycle may synthesize into `sourceId`; every other corpus file is counted in `routing`. */
export async function keepSessionSourceTranscripts(engine: BrainEngine, transcripts: DiscoveredTranscript[],
  opts: { corpusDir: string | null; sourceId: string }, routing: SessionSourceRouting): Promise<DiscoveredTranscript[]> {
  if (!opts.corpusDir) return transcripts;
  const kept: DiscoveredTranscript[] = [];
  for (const t of transcripts) {
    const location = t.filePath.startsWith(CONVERSATION_PAGE_URI_PREFIX) ? null : corpusLocation(t.filePath, opts.corpusDir);
    if (!location) { kept.push(t); continue; }
    const owner = await resolveCorpusFileSource(engine, opts.corpusDir, basename(t.filePath), location);
    if (!owner.ok) routing.held[owner.reason] = (routing.held[owner.reason] ?? 0) + 1;
    else if (owner.sourceId !== opts.sourceId) routing.corpus_source_other[owner.sourceId] = (routing.corpus_source_other[owner.sourceId] ?? 0) + 1;
    else kept.push(t);
  }
  return kept;
}

/** Names every corpus file the phase left out, with the command that synthesizes (or extracts) or releases it. */
export function withSessionSourceRouting(result: PhaseResult, routing: SessionSourceRouting, sourceId: string,
  phase: 'synthesize' | 'extract_atoms' = 'synthesize'): PhaseResult {
  const others = Object.entries(routing.corpus_source_other).sort(([a], [b]) => a.localeCompare(b));
  const held = Object.entries(routing.held).sort(([a], [b]) => a.localeCompare(b));
  if (!others.length && !held.length) return result;
  const otherCount = others.reduce((n, [, c]) => n + c, 0);
  const heldCount = held.reduce((n, [, c]) => n + c, 0);
  const fix = [
    ...others.map(([id]) => `gbrain dream --source ${id} --phase ${phase}`),
    ...(heldCount ? ['gbrain sweep --assign-corpus <source>'] : []),
  ];
  const parts = [
    ...(otherCount ? [`${otherCount} corpus file(s) belong to other sources (${others.map(([id, c]) => `${id}: ${c}`).join(', ')}) and ${phase === 'synthesize' ? 'synthesize' : 'extract'} only under their own source`] : []),
    ...(heldCount ? [`${heldCount} held with no frozen session source (${held.map(([r, c]) => `${r}: ${c}`).join(', ')})`] : []),
  ];
  process.stderr.write(`[dream] ${phase} for source ${sourceId}: ${parts.join('; ')}. Fix: ${fix.join(' | ')}\n`);
  return { ...result, summary: `${result.summary}; ${parts.join('; ')}`,
    details: { ...result.details, source_routing: { source_id: sourceId, ...routing, fix } } };
}
