import { describe, expect, test, beforeEach } from 'bun:test';
import {
  ruleStopping, ruleAnswers, getStoppingDecision, resetStoppingBreaker,
  DEFAULT_STOPPING_CONFIG, type StoppingAsk,
} from '../src/core/search/stopping-decider.ts';

const A = (p: Partial<StoppingAsk>): StoppingAsk =>
  ({ evidence_sufficient: 0, continue_useful: 0, missing_evidence: 0, contradiction: 0, ...p });

describe('stopping rules (Jev-Mem borrow)', () => {
  test('evidence_sufficient >= threshold stops', () => {
    const d = ruleStopping(A({ evidence_sufficient: 0.96, continue_useful: 0.9 }), 1, DEFAULT_STOPPING_CONFIG);
    expect(d.stop).toBe(true);
    expect(d.stop_reason).toBe('evidence_sufficient');
  });
  test('continue_useful <= floor stops', () => {
    const d = ruleStopping(A({ continue_useful: 0.1 }), 1, DEFAULT_STOPPING_CONFIG);
    expect(d.stop_reason).toBe('continue_useful_low');
  });
  test('contradiction forces expansion (probe round)', () => {
    const d = ruleStopping(A({ evidence_sufficient: 0.99, contradiction: 0.7 }), 1, DEFAULT_STOPPING_CONFIG);
    expect(d.stop).toBe(false);
    expect(d.stop_reason).toBe('contradiction_probe');
  });
  test('max rounds hard cap wins over everything', () => {
    const d = ruleStopping(A({ contradiction: 1, continue_useful: 1 }), 3, DEFAULT_STOPPING_CONFIG);
    expect(d.stop).toBe(true);
    expect(d.stop_reason).toBe('max_rounds');
  });
  test('default: continue useful => expand', () => {
    const d = ruleStopping(A({ continue_useful: 0.6, missing_evidence: 0.7 }), 1, DEFAULT_STOPPING_CONFIG);
    expect(d.stop).toBe(false);
    expect(d.stop_reason).toBe('continue_useful');
  });
  test('rule digest: empty => expand, sparse/weak => expand, healthy => stop', () => {
    expect(ruleAnswers(0, 0).continue_useful).toBe(0.9);
    expect(ruleAnswers(3, 0.9).evidence_sufficient).toBeLessThan(0.95);
    expect(ruleAnswers(8, 0.4).evidence_sufficient).toBeLessThan(0.95); // weak top score
    expect(ruleAnswers(8, 0.7).evidence_sufficient).toBe(0.9);
    expect(ruleStopping(ruleAnswers(8, 0.7), 1, DEFAULT_STOPPING_CONFIG).stop).toBe(true);
  });
});

describe('stopping decider client', () => {
  const engine = (cfg: Record<string, string>) =>
    ({ getConfig: async (k: string) => cfg[k] ?? null } as never);
  const hit = { slug: 'a', score: 0.8 } as never;

  test('no url => rule answer', async () => {
    const hits = Array.from({ length: 8 }, (_, i) => ({ slug: 'p' + i, score: 0.7 }) as never);
    const d = await getStoppingDecision(engine({}), 'q', hits, 1);
    expect(d.decider).toBe('fallback');
    expect(d.stop).toBe(true); // >=5 hits, strong scores => healthy digest => stop
  });
  test('julia answers => julia provenance', async () => {
    resetStoppingBreaker();
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      answers: {
        evidence_sufficient: { type: 'noul', noul: 0.2 },
        continue_useful: { type: 'noul', noul: 0.8 },
        missing_evidence: { type: 'noul', noul: 0.7 },
        contradiction: { type: 'noul', noul: 0.1 },
      },
    }), { status: 200 })) as never;
    const d = await getStoppingDecision(
      engine({ 'search.stopping_decider_url': 'http://j/v1/systemone' }), 'q', [hit], 1);
    globalThis.fetch = orig;
    expect(d.decider).toBe('julia');
    expect(d.stop).toBe(false);
    expect(d.stop_reason).toBe('continue_useful');
  });
  test('fetch failure => rules fail-soft', async () => {
    resetStoppingBreaker();
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error('down'); }) as never;
    const hits = Array.from({ length: 6 }, (_, i) => ({ slug: 'p' + i, score: 0.8 }) as never);
    const d = await getStoppingDecision(
      engine({ 'search.stopping_decider_url': 'http://j/v1/systemone' }), 'q', hits, 1);
    globalThis.fetch = orig;
    expect(d.decider).toBe('fallback');
    expect(d.stop).toBe(true);
  });
});
