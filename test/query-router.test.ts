import { describe, expect, test } from 'bun:test';
import {
  allocateBudgets, ruleRoute, DEFAULT_BUDGET_CONFIG, NEEDS,
  type RetrievalNeed,
} from '../src/core/search/query-router.ts';

const REF = '2026-10-19';
const needs = (p: Partial<Record<RetrievalNeed, number>>): Record<RetrievalNeed, number> =>
  ({ semantic: 0, temporal: 0, causal: 0, entity: 0, ...p });

describe('allocateBudgets (largest-remainder, Jev-Mem port)', () => {
  test('sum never exceeds total; all arms integer', () => {
    const cases = [
      needs({ semantic: 1, temporal: 1, causal: 1, entity: 1 }),
      needs({ semantic: 0.9, temporal: 0.3, causal: 0.0, entity: 0.2 }),
      needs({ temporal: 0.05 }), // below threshold: all zero
      needs({ semantic: 0.6 }),
      needs({ semantic: 0.26, temporal: 0.25, causal: 0.25, entity: 0.25 }),
    ];
    for (const n of cases) {
      const b = allocateBudgets(n);
      const sum = NEEDS.reduce((s, k) => s + b[k], 0);
      const active = NEEDS.filter((k) => n[k] >= DEFAULT_BUDGET_CONFIG.activationThreshold);
      expect(sum).toBe(active.length > 0 ? DEFAULT_BUDGET_CONFIG.total : 0);
      for (const k of NEEDS) expect(Number.isInteger(b[k])).toBe(true);
    }
  });
  test('activation threshold gates arms out with zero', () => {
    const b = allocateBudgets(needs({ semantic: 0.6, entity: 0.24 }), DEFAULT_BUDGET_CONFIG);
    expect(b.entity).toBe(0);
    expect(b.semantic).toBe(40);
  });
  test('sharpening: dominant need gets most of the budget', () => {
    const b = allocateBudgets(needs({ semantic: 0.6, temporal: 1.0 }));
    expect(b.temporal).toBeGreaterThan(b.semantic);
  });
  test('minimum quota per active arm', () => {
    const b = allocateBudgets(needs({ semantic: 0.6, temporal: 1.0, causal: 0.9, entity: 0.8 }));
    for (const k of NEEDS) expect(b[k]).toBeGreaterThanOrEqual(1);
  });
  test('deterministic tie-break (lexicographic on equal fractions)', () => {
    const a = allocateBudgets(needs({ semantic: 0.5, temporal: 0.5, causal: 0.5, entity: 0.5 }));
    const b = allocateBudgets(needs({ semantic: 0.5, temporal: 0.5, causal: 0.5, entity: 0.5 }));
    expect(a).toEqual(b);
    // equal needs + exponent => equal shares: 10 each
    expect(a).toEqual({ causal: 10, entity: 10, semantic: 10, temporal: 10 });
  });
  test('tiny total: budget-limited activation keeps highest-need arms', () => {
    const b = allocateBudgets(needs({ semantic: 0.9, temporal: 0.8, causal: 0.7, entity: 0.6 }),
      { ...DEFAULT_BUDGET_CONFIG, total: 2, minimum: 1 });
    expect(b.semantic).toBeGreaterThanOrEqual(1);
    expect(NEEDS.reduce((s, k) => s + b[k], 0)).toBe(2);
  });
});

describe('ruleRoute', () => {
  test('resolved time range => temporal 1.0', () => {
    expect(ruleRoute('上周 WOL 修复的经过', REF).temporal).toBe(1.0);
    expect(ruleRoute('2026年10月17日 做了什么', REF).temporal).toBe(1.0);
  });
  test('time interrogative (no resolvable range) => temporal 0.7', () => {
    expect(ruleRoute('WOL 修复是什么时候做的', REF).temporal).toBe(0.7);
  });
  test('causal vocab => causal 0.9', () => {
    expect(ruleRoute('WOL 叫不醒的根因是什么', REF).causal).toBe(0.9);
    expect(ruleRoute('为什么 julia 会向上偏一档', REF).causal).toBe(0.9);
  });
  test('entity lexicon => entity 0.8', () => {
    expect(ruleRoute('.80 上的 ComfyUI 怎么启动', REF).entity).toBe(0.8);
    expect(ruleRoute('gbrain 的 dream 作业跑什么', REF).entity).toBe(0.8);
  });
  test('plain query: semantic baseline only', () => {
    const r = ruleRoute('番茄炒蛋怎么做', REF);
    expect(r).toEqual({ semantic: 0.6, temporal: 0, causal: 0, entity: 0 });
  });
  test('combined: temporal+causal+entity all fire together', () => {
    const r = ruleRoute('上周 .80 为什么 WOL 叫不醒', REF);
    expect(r.temporal).toBe(1.0);
    expect(r.causal).toBe(0.9);
    expect(r.entity).toBe(0.8);
  });
  test('golden eval queries route to their gold category (train/label sanity)', () => {
    // mirrors gold.jsonl categories: temporal queries must score temporal
    // highest among non-semantic arms; causal likewise.
    const t = ruleRoute('前天晚上部署了哪个模型', REF);
    expect(t.temporal).toBe(1.0);
    const c = ruleRoute('为什么决定用本地模型而不是 API', REF);
    expect(c.causal).toBe(0.9);
  });
});
