import { describe, expect, test, beforeEach } from 'bun:test';
import { getRoutingNeeds, resetRoutingBreaker } from '../src/core/search/routing-decider.ts';

const engine = (cfg: Record<string, string>) =>
  ({ getConfig: async (k: string) => cfg[k] ?? null } as never);

function mockFetch(fn: () => Promise<Response>) {
  const orig = globalThis.fetch;
  globalThis.fetch = fn as never;
  return () => { globalThis.fetch = orig; };
}

const ok4 = (p: [number, number, number, number]) =>
  new Response(JSON.stringify({
    answers: {
      semantic: { type: 'noul', noul: p[0] },
      temporal: { type: 'noul', noul: p[1] },
      causal: { type: 'noul', noul: p[2] },
      entity: { type: 'noul', noul: p[3] },
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });

describe('routing decider', () => {
  beforeEach(() => resetRoutingBreaker());

  test('no url configured => rules fallback', async () => {
    const d = await getRoutingNeeds(engine({}), '上周 WOL 修复');
    expect(d.decider).toBe('fallback');
    expect(d.needs.temporal).toBe(1.0);
  });
  test('julia answers => julia provenance + probabilities pass through', async () => {
    const restore = mockFetch(async () => ok4([0.9, 0.1, 0.2, 0.8]));
    const d = await getRoutingNeeds(engine({ 'search.routing_decider_url': 'http://j/v1/systemone' }), 'q');
    restore();
    expect(d.decider).toBe('julia');
    expect(d.needs).toEqual({ semantic: 0.9, temporal: 0.1, causal: 0.2, entity: 0.8 });
  });
  test('fetch failure => fallback', async () => {
    const restore = mockFetch(async () => { throw new Error('boom'); });
    const d = await getRoutingNeeds(
      engine({ 'search.routing_decider_url': 'http://j/v1/systemone' }), '为什么 julia 偏档');
    restore();
    expect(d.decider).toBe('fallback');
    expect(d.needs.causal).toBe(0.9);
  });
  test('malformed answers => fallback', async () => {
    const restore = mockFetch(async () =>
      new Response(JSON.stringify({ answers: { semantic: { type: 'noul' } } }), { status: 200 }));
    const d = await getRoutingNeeds(engine({ 'search.routing_decider_url': 'http://j/v1/systemone' }), 'q');
    restore();
    expect(d.decider).toBe('fallback');
  });
  test('breaker: 3 consecutive failures short-circuit to rules', async () => {
    let calls = 0;
    const restore = mockFetch(async () => { calls++; throw new Error('down'); });
    for (let i = 0; i < 4; i++) {
      const d = await getRoutingNeeds(engine({ 'search.routing_decider_url': 'http://j/v1/systemone' }), 'q');
      expect(d.decider).toBe('fallback');
    }
    restore();
    expect(calls).toBe(3); // 4th call never hits the network
  });
});
