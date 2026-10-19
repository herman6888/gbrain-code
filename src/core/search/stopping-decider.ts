/**
 * Evidence-sufficiency stopping decider (fork: Jev-Mem borrowing Phase 4).
 *
 * After a retrieval round, ask four noul propositions (Jev-Mem
 * stopping_questions, zh port) over the query + a digest of retrieved
 * evidence, then decide stop vs expand. Fail-soft by design: when no LLM
 * decider is configured (or it fails), a deterministic digest rule answers —
 * sparse evidence expands, healthy evidence stops — so the loop degrades to
 * predictable rules, never to extra rounds on flaky infra. Every decision
 * carries an explicit stop_reason for the audit trail (Phase 2 schema).
 */
import type { BrainEngine } from '../engine.ts';
import type { SearchResult } from '../types.ts';

export interface StoppingAsk {
  evidence_sufficient: number;
  continue_useful: number;
  missing_evidence: number;
  contradiction: number;
}
export interface StoppingDecision {
  stop: boolean;
  stop_reason: string;
  answers: StoppingAsk;
  decider: 'julia' | 'fallback';
}

export const STOPPING_QUESTIONS: Record<keyof StoppingAsk, { instructions: string; yes: string; no: string }> = {
  evidence_sufficient: {
    instructions: '给定 `query` 和 `evidence`，证据是否包含生成完整答案所需的支撑？',
    yes: '能基于这些记忆给出有根据的回答，无需编造缺失事实。',
    no: '关键事实或推理链缺少支撑；仅主题相关不够。',
  },
  continue_useful: {
    instructions: '给定 `query` 和 `evidence`，再检索一轮是否可能填补具体缺口或化解冲突？',
    yes: '存在可指认的缺失事实或冲突，多取记忆可能补上。',
    no: '没有可指认的检索需求，继续取帮助不大。',
  },
  missing_evidence: {
    instructions: '`query` 所需的至少一项事实是否不在 `evidence` 中？',
    yes: '有细节、日期、身份、数量或连接性事实缺乏支撑。',
    no: '所需事实都有明确支撑。',
  },
  contradiction: {
    instructions: '`evidence` 是否含有就 `query` 相关、且以现有时间/语境无法调和的相互冲突的陈述？',
    yes: '存在仍影响答案对错的冲突。',
    no: '陈述一致、可由时间更新解释、或不影响答案。',
  },
};

export interface StoppingConfig {
  /** evidence_sufficient at/above this stops the loop. */
  sufficientThreshold: number;
  /** continue_useful at/below this stops the loop. */
  continueFloor: number;
  /** contradiction at/above this forces one more round (conflict evidence). */
  contradictionFloor: number;
  /** hard cap on rounds including the first. */
  maxRounds: number;
}

export const DEFAULT_STOPPING_CONFIG: StoppingConfig = {
  sufficientThreshold: 0.95,
  continueFloor: 0.15,
  contradictionFloor: 0.6,
  maxRounds: 3,
};

/**
 * Deterministic fallback over the retrieval digest (no LLM): what the julia
 * distillation will be trained from. Precision-biased toward stopping —
 * expansion costs a whole extra retrieval round.
 */
export function ruleStopping(answers: StoppingAsk, round: number, cfg: StoppingConfig): StoppingDecision {
  const base = decide(answers, round, cfg, 'fallback');
  return base;
}

function decide(answers: StoppingAsk, round: number, cfg: StoppingConfig, decider: 'julia' | 'fallback'): StoppingDecision {
  if (round >= cfg.maxRounds) return { stop: true, stop_reason: 'max_rounds', answers, decider };
  if (answers.contradiction >= cfg.contradictionFloor)
    return { stop: false, stop_reason: 'contradiction_probe', answers, decider };
  if (answers.evidence_sufficient >= cfg.sufficientThreshold)
    return { stop: true, stop_reason: 'evidence_sufficient', answers, decider };
  if (answers.continue_useful <= cfg.continueFloor)
    return { stop: true, stop_reason: 'continue_useful_low', answers, decider };
  return { stop: false, stop_reason: 'continue_useful', answers, decider };
}

/** Rule digest: sparse evidence => expand; healthy => stop. */
export function ruleAnswers(hits: number, topScore: number): StoppingAsk {
  if (hits === 0) return { evidence_sufficient: 0.0, continue_useful: 0.9, missing_evidence: 0.9, contradiction: 0 };
  if (hits < 5 || topScore < 0.45) return { evidence_sufficient: 0.4, continue_useful: 0.65, missing_evidence: 0.6, contradiction: 0 };
  return { evidence_sufficient: 0.9, continue_useful: 0.1, missing_evidence: 0.1, contradiction: 0 };
}

function evidenceDigest(query: string, results: SearchResult[]): string {
  const top = results.slice(0, 5).map((r) => `- ${r.slug}: ${(r as { snippet?: string }).snippet?.slice(0, 200) ?? ''}`).join('\n');
  return `query: ${query}\nevidence:\n${top}`;
}

let consecutiveFailures = 0;
let breakerOpenUntil = 0;
/** @internal test hook */
export function resetStoppingBreaker(): void { consecutiveFailures = 0; breakerOpenUntil = 0; }

/**
 * Ask the julia JEV endpoint (:8907) the four stopping questions; rules
 * answer on any failure. Breaker mirrors routing-decider (3 fails, 60s).
 */
export async function getStoppingDecision(
  engine: BrainEngine,
  query: string,
  results: SearchResult[],
  round: number,
  cfg: StoppingConfig = DEFAULT_STOPPING_CONFIG,
): Promise<StoppingDecision> {
  let url = '';
  let timeoutMs = 1000;
  try {
    url = (await engine.getConfig('search.stopping_decider_url').catch(() => null))?.trim() ?? '';
    timeoutMs = Number((await engine.getConfig('search.stopping_decider_timeout_ms').catch(() => null))?.trim()) || 1000;
  } catch { /* rules */ }
  if (!url || Date.now() < breakerOpenUntil) {
    return ruleStopping(ruleAnswers(results.length, results[0]?.score ?? 0), round, cfg);
  }
  const answers = await askJuliaStopping(url, evidenceDigest(query, results), timeoutMs);
  if (!answers) {
    if (++consecutiveFailures >= 3) breakerOpenUntil = Date.now() + 60_000;
    return ruleStopping(ruleAnswers(results.length, results[0]?.score ?? 0), round, cfg);
  }
  consecutiveFailures = 0;
  return decide(answers, round, cfg, 'julia');
}

async function askJuliaStopping(url: string, state: string, timeoutMs: number): Promise<StoppingAsk | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const keys = Object.keys(STOPPING_QUESTIONS) as (keyof StoppingAsk)[];
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer gbrain' },
      body: JSON.stringify({
        state,
        questions: Object.fromEntries(keys.map((k) => [k, {
          type: 'noul',
          instructions: STOPPING_QUESTIONS[k].instructions,
          criteria: { true: STOPPING_QUESTIONS[k].yes, false: STOPPING_QUESTIONS[k].no },
        }])),
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { answers?: Record<string, { noul?: number; probabilities?: Record<string, number> }> };
    const out = {} as StoppingAsk;
    for (const k of keys) {
      const a = json.answers?.[k];
      const p = typeof a?.noul === 'number' ? a.noul : a?.probabilities?.true;
      if (typeof p !== 'number' || !(p >= 0 && p <= 1)) return null;
      out[k] = p;
    }
    return out;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
