/**
 * Routing decider client (fork: Jev-Mem borrowing Phase 3).
 *
 * Asks the julia JEV endpoint (:8907, typesafe-sdk systemone protocol) the
 * four routing noul propositions (query-router.ts prompts), returning
 * per-arm probabilities. Fail-soft by design: on timeout, breaker-open,
 * malformed response, or missing config, falls back to the deterministic
 * rule annotator (ruleRoute) — the same distribution julia was distilled
 * from, so routing degrades to rules, never to a coin flip. The audit entry
 * records `decider: 'julia' | 'fallback'` so operators see the true rate.
 */
import type { BrainEngine } from '../engine.ts';
import { ruleRoute, ROUTING_QUESTIONS, type RetrievalNeed } from './query-router.ts';
import { dayInZone } from '../effective-date.ts';

export type RouteNeeds = Record<RetrievalNeed, number>;
export interface RoutingDecision {
  needs: RouteNeeds;
  decider: 'julia' | 'fallback';
}

const DEFAULT_TIMEOUT_MS = 800;

interface SystemOneAnswer { type?: string; noul?: number; probabilities?: Record<string, number> }
interface SystemOneResponse { answers?: Record<string, SystemOneAnswer> }

let consecutiveFailures = 0;
let breakerOpenUntil = 0;

/** @internal test hook */
export function resetRoutingBreaker(): void {
  consecutiveFailures = 0;
  breakerOpenUntil = 0;
}

async function askJulia(url: string, query: string, timeoutMs: number): Promise<RouteNeeds | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const qids: RetrievalNeed[] = ['semantic', 'temporal', 'causal', 'entity'];
    const body = {
      state: query,
      questions: Object.fromEntries(qids.map((k) => [k, {
        type: 'noul',
        instructions: ROUTING_QUESTIONS[k].instructions,
        criteria: { true: ROUTING_QUESTIONS[k].yes, false: ROUTING_QUESTIONS[k].no },
      }])),
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer gbrain' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as SystemOneResponse;
    const needs: RouteNeeds = { semantic: 0, temporal: 0, causal: 0, entity: 0 };
    for (const k of qids) {
      const a = json.answers?.[k];
      if (!a) return null;
      const p = typeof a.noul === 'number' ? a.noul
        : (a.probabilities?.true ?? a.probabilities?.yes);
      if (typeof p !== 'number' || !(p >= 0 && p <= 1)) return null;
      needs[k] = p;
    }
    return needs;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Four-arm routing probabilities + provenance. Breaker: 3 consecutive
 * julia failures open a 60s window during which rules answer directly.
 */
export async function getRoutingNeeds(
  engine: BrainEngine,
  query: string,
): Promise<RoutingDecision> {
  const fallback = (): RoutingDecision => ({
    needs: ruleRoute(query, refDate()),
    decider: 'fallback',
  });
  let url = '';
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  try {
    url = (await engine.getConfig('search.routing_decider_url').catch(() => null))?.trim() ?? '';
    timeoutMs = Number((await engine.getConfig('search.routing_decider_timeout_ms').catch(() => null))?.trim()) || DEFAULT_TIMEOUT_MS;
  } catch {
    return fallback();
  }
  if (!url) return fallback();
  if (Date.now() < breakerOpenUntil) return fallback();
  const needs = await askJulia(url, query, timeoutMs);
  if (!needs) {
    if (++consecutiveFailures >= 3) breakerOpenUntil = Date.now() + 60_000;
    return fallback();
  }
  consecutiveFailures = 0;
  return { needs, decider: 'julia' };
}

function refDate(): string {
  // Day-level accuracy is all the rule annotator needs; brain.timezone is
  // read async by the callers that need exact local days.
  try {
    return dayInZone(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}
