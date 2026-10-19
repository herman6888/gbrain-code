import { describe, expect, test } from 'bun:test';
import { autoTimeScopeValueProblem, AUTO_TIME_SCOPE_MODES } from '../src/core/search/auto-time-scope.ts';
import { searchConfigValueRefusal } from '../src/core/search/config-values.ts';
import { applyAutoTimeScope, type AutoTimeScope } from '../src/core/search/auto-time-scope.ts';
import type { SearchResult } from '../src/core/types.ts';

function row(slug: string, date?: string): SearchResult {
  return { slug, page_id: 1, title: slug, type: 'note' as never, chunk_text: '', chunk_source: 'compiled_truth', chunk_id: 1, chunk_index: 0, score: 1, stale: false, effective_date: date };
}

describe('auto_time_scope config validation', () => {
  test('accepts the three modes, rejects junk', () => {
    for (const m of AUTO_TIME_SCOPE_MODES) expect(autoTimeScopeValueProblem(m)).toBeNull();
    expect(autoTimeScopeValueProblem('yes')).toContain('expected one of');
    expect(searchConfigValueRefusal('search.auto_time_scope', 'yes')).not.toBeNull();
    expect(searchConfigValueRefusal('search.auto_time_scope', 'partition')).toBeNull();
  });
});

describe('applyAutoTimeScope', () => {
  const scope: AutoTimeScope = { mode: 'reserved', range: { start: '2026-10-17', end: '2026-10-17' }, cue: '2026-10-17', reference_date: '2026-10-17' };
  test('in-range pages move into the fill slots; nothing dropped', () => {
    const rows = [row('a', '2026-09-01'), row('b', '2026-10-17'), row('c'), row('d', '2026-10-25'), row('e', '2026-10-17')];
    const out = applyAutoTimeScope(rows, scope, 4);
    expect(out.results.length).toBe(5);
    expect(out.inRange).toBe(2);
    // reserved: keep ceil(k/2)=2 head, fill next slots with in-range
    expect(out.results[0].slug).toBe('a');
    expect(out.results[1].slug).toBe('b');
    expect(out.results[2].slug).toBe('e');
    expect(out.results[3].slug).toBe('c');
  });
  test('no in-range result → input order untouched (fail-open)', () => {
    const rows = [row('a', '2026-09-01'), row('b'), row('c', '2026-01-01')];
    const out = applyAutoTimeScope(rows, scope, 3);
    expect(out.results.map(r => r.slug)).toEqual(['a', 'b', 'c']);
    expect(out.moved).toBe(0);
  });
});
