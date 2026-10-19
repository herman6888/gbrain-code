/**
 * Auto time scope (fork extension, Jev-Mem borrowing Phase 1): when a query
 * names an explicit time (Chinese or English cues in temporal-grammar.ts),
 * re-order the final ranked results so in-range pages surface first — soft,
 * never drops, fail-open on any parse/metadata gap.
 *
 * Config `search.auto_time_scope`: 'off' (default) | 'reserved' | 'partition'
 * (modes inherited from the longmemeval time-scope arm, see hybrid/time-scope.ts).
 * Explicit `since`/`until` (CLI flags / SearchOpts date bounds) always win:
 * the auto path is skipped when the caller already scoped the search.
 */
import type { BrainEngine } from '../engine.ts';
import type { SearchResult } from '../types.ts';
import type { DayRange } from '../temporal-grammar.ts';
import { parseQueryTimeRange } from './time-range.ts';
import { dayInZone } from '../effective-date.ts';
import { applyTimeScope, type TimeScopeMode } from './hybrid/time-scope.ts';

export const AUTO_TIME_SCOPE_KEY = 'search.auto_time_scope';
export const AUTO_TIME_SCOPE_MODES = ['off', 'reserved', 'partition'] as const;
export type AutoTimeScopeMode = (typeof AUTO_TIME_SCOPE_MODES)[number];

export function autoTimeScopeValueProblem(value: string): string | null {
  return (AUTO_TIME_SCOPE_MODES as readonly string[]).includes(value) ? null : `expected one of: ${AUTO_TIME_SCOPE_MODES.join(', ')}`;
}

export interface AutoTimeScope {
  mode: Exclude<AutoTimeScopeMode, 'off'>;
  range: DayRange;
  cue: string;
  reference_date: string;
}

/** Resolve the auto scope for a query; null when off, abstained, or caller-scoped. */
export async function resolveAutoTimeScope(
  engine: BrainEngine,
  query: string,
  opts: { since?: string; until?: string; afterDate?: string; beforeDate?: string },
): Promise<AutoTimeScope | null> {
  if (opts.since || opts.until || opts.afterDate || opts.beforeDate) return null;
  const mode = (await engine.getConfig(AUTO_TIME_SCOPE_KEY).catch(() => null))?.trim();
  if (mode !== 'reserved' && mode !== 'partition') return null;
  const timeZone = (await engine.getConfig('brain.timezone').catch(() => null))?.trim() || null;
  const ref = dayInZone(new Date(), timeZone ?? 'UTC');
  const parsed = parseQueryTimeRange(query, ref);
  if (parsed.reason !== 'applied' || !parsed.range) return null;
  return { mode, range: parsed.range, cue: parsed.range.cue, reference_date: parsed.range.reference_date };
}

function resultDates(r: SearchResult): DayRange[] | undefined {
  return r.effective_date ? [{ start: r.effective_date, end: r.effective_date }] : undefined;
}

/** Soft re-order; returns the input order untouched when nothing is in range. */
export function applyAutoTimeScope(results: SearchResult[], scope: AutoTimeScope, k: number): { results: SearchResult[]; inRange: number; moved: number } {
  return applyTimeScope(results, scope.range, resultDates, { mode: scope.mode, k });
}
