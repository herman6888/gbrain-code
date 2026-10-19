/**
 * Query router + budget allocation (fork: Jev-Mem borrowing Phase 3).
 *
 * A System-One style controller classifies each query into four retrieval
 * needs (semantic / temporal / causal / entity), then a largest-remainder
 * integer allocation turns the probabilities into per-arm candidate budgets.
 * Ported from Jev-Mem's allocate_graph_budgets (jev_mem_policies.py).
 *
 * Producers of `needs`:
 *   - ruleRoute(): deterministic zero-LLM rule annotator. Used as the
 *     training-data labeler and as the runtime fail-soft baseline.
 *   - julia (Phase 3 wiring): four noul propositions, same schema.
 *
 * Budget map for gbrain arms:
 *   semantic -> vector/FTS top-k, temporal -> time-scoped pages (Phase 1),
 *   entity   -> entities pages + 1-hop links, causal -> takes + causal links.
 */
import { parseQueryTimeRange } from './time-range.ts';

export type RetrievalNeed = 'semantic' | 'temporal' | 'causal' | 'entity';
export const NEEDS: readonly RetrievalNeed[] = ['semantic', 'temporal', 'causal', 'entity'];

export interface BudgetConfig {
  /** Total integer candidates to allocate across active arms. */
  total: number;
  /** A need activates only at/above this probability. */
  activationThreshold: number;
  /** Minimum candidates per active arm. */
  minimum: number;
  /** Sharpening exponent on relative weights (Jev-Mem: probability_exponent). */
  exponent: number;
}

export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  total: 40,
  activationThreshold: 0.25,
  minimum: 1,
  exponent: 2,
};

/**
 * Largest-remainder integer allocation; total never exceeds cfg.total.
 * Faithful port of Jev-Mem allocate_graph_budgets: activate needs >=
 * threshold, guarantee `minimum` each (budget-limited to highest needs),
 * sharpen weights by (p/pmax)^exponent, floor the shares, hand out the
 * remainder by largest fractional part (ties: lexicographic arm order).
 */
export function allocateBudgets(
  needs: Record<RetrievalNeed, number>,
  cfg: BudgetConfig = DEFAULT_BUDGET_CONFIG,
): Record<RetrievalNeed, number> {
  const budgets = Object.fromEntries(NEEDS.map((n) => [n, 0])) as Record<RetrievalNeed, number>;
  let active = NEEDS.filter((n) => needs[n] > 0 && needs[n] >= cfg.activationThreshold);
  if (active.length === 0 || cfg.total <= 0) return budgets;
  active = [...active].sort((a, b) => (needs[b] - needs[a]) || a.localeCompare(b));
  let minimum = cfg.minimum;
  if (minimum > 0) {
    active = active.slice(0, Math.max(1, Math.floor(cfg.total / minimum)));
    minimum = Math.min(minimum, cfg.total);
  }
  for (const n of active) budgets[n] = minimum;
  const remaining = cfg.total - active.length * minimum;
  if (remaining > 0) {
    const pmax = Math.max(...active.map((n) => needs[n]));
    const weights = Object.fromEntries(active.map((n) => [n, Math.pow(needs[n] / pmax, cfg.exponent)]));
    const wsum = active.reduce((s, n) => s + weights[n], 0);
    const shares = Object.fromEntries(active.map((n) => [n, (remaining * weights[n]) / wsum]));
    for (const n of active) budgets[n] += Math.floor(shares[n]);
    const byFrac = [...active].sort((a, b) => ((shares[b] % 1) - (shares[a] % 1)) || a.localeCompare(b));
    let left = cfg.total - NEEDS.reduce((s, n) => s + budgets[n], 0);
    for (const n of byFrac) {
      if (left <= 0) break;
      budgets[n] += 1;
      left -= 1;
    }
  }
  return budgets;
}

// ----------------------------------------------------------------------
// Rule annotator (zero-LLM): training labeler + runtime fail-soft baseline
// ----------------------------------------------------------------------

/** Causal-question vocabulary (zh) + key English causal connectors. */
const CAUSAL_RE = /为什么|为何|原因|根因|因何|由于|因为|导致|引发|触发|致使|后果|所以|故|动机|目的|why|cause|caused|because/i;
/** Time-interrogatives the Phase 1 grammar does NOT resolve as ranges. */
const TEMPORAL_ASK_RE = /何时|什么时候|哪天|几点|哪一天|多久|时间线|先后顺序|when\b|timeline/i;
/** Stable infrastructure/project entity vocabulary observed in this brain. */
const ENTITY_RE = new RegExp([
  'gbrain', 'openviking', 'ov(?![a-z])', 'halogen', 'julia', 'kev', 'comfyui', 'openclash',
  'easytier', 'omarchy', 'quickshell', 'studio', 'hermes', 'ekko', 'whisper', 'strata',
  '飞书', 'lark', 'anysearch', 'agent-?reach', 'deepseek', '(?<![a-z])pi(?![a-z])', 'codex', 'smartdns', 'mosdns',
  'vless', 'clash', 'xbox', '(?<![a-z])core(?![a-z])', 'd3-lite', 'decider', 'bge-m3', 'openrouter', 'opencode',
  '\\.9[018]\\b', '\\.8[09]\\b', '192\\.168\\.8\\.\\d+', '(?<![a-z])wol(?![a-z])', '(?<![a-z])nas(?![a-z])',
  '(?<![a-z])vps(?![a-z])', '(?<![a-z])ssh(?![a-z])', '公众号', '小红书', '路由器', '虚拟机', '游戏机', '面板',
  'pmbrain', '(?<![a-z])exa(?![a-z])', 'mcporter', 'live-panel', '(?<![a-z])jev',
  'arctic', 'reddit', 'switch2', '(?<![a-z])xsx(?![a-z])', 'teredo', 'openrig', '电台调频', 'ubuntu',
  '微博', '知乎', 'b站', '头条', 'strix', '(?<![a-z])gpu(?![a-z])', 'agent-daily-journal', '(?<![a-z])npu(?![a-z])',
  'reasoning-gate', 'c源', 'wechat-articles', '调度台', '(?<![a-z])cjk(?![a-z])',
].join('|'), 'i');

/**
 * Deterministic rule route: Phase 1 temporal grammar + causal/time question
 * words + entity lexicon. Precision-biased: no cue => no score. semantic is
 * always a moderate baseline (every query has some semantic need).
 */
export function ruleRoute(query: string, referenceDate: string): Record<RetrievalNeed, number> {
  const needs: Record<RetrievalNeed, number> = { semantic: 0.6, temporal: 0, causal: 0, entity: 0 };
  if (parseQueryTimeRange(query, referenceDate).range) needs.temporal = 1.0;
  else if (TEMPORAL_ASK_RE.test(query)) needs.temporal = 0.7;
  if (CAUSAL_RE.test(query)) needs.causal = 0.9;
  if (ENTITY_RE.test(query)) needs.entity = 0.8;
  return needs;
}

/**
 * julia routing prompts (zh port of Jev-Mem routing_questions, four noul
 * propositions). Keys MUST stay in sync with the training-data schema.
 */
export const ROUTING_QUESTIONS: Record<RetrievalNeed, { instructions: string; yes: string; no: string }> = {
  semantic: {
    instructions: '回答 `query` 是否需要查找主题上、语义上相关的记忆内容？',
    yes: '对相关事实的回忆有助于回答。',
    no: '不需要查找相关内容。',
  },
  temporal: {
    instructions: '回答 `query` 是否需要事件日期、时长、先后顺序或随时间发生的变化？',
    yes: '必须用到时间关系才能答对。',
    no: '日期或顺序与答案无关。',
  },
  causal: {
    instructions: '回答 `query` 是否需要解释原因、动机、促成条件或结果？',
    yes: '需要因果或解释性证据。',
    no: '只询问事实关联或时间先后。',
  },
  entity: {
    instructions: '把同一个人、机器、项目、组织（含别名/简称）的提及连接起来，是否有助于回答 `query`？',
    yes: '汇总实体专属事实或别名合并有用。',
    no: '实体身份与答案无关。',
  },
};
