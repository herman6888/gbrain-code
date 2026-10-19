/**
 * Retrieval decision audit trail (fork: Jev-Mem borrowing Phase 2).
 *
 * Every production search appends one JSONL line to an append-only,
 * day-rotated audit file: how it routed, what budget it spent, why it
 * stopped, whether the decider fell back. Queries are stored as a
 * 12-hex sha256 prefix (privacy: no raw CJK text on disk), matching the
 * Jev-Mem decisions.jsonl observability pattern.
 *
 * Gated by config `search.audit_log` (off|on, default off). Writes are
 * best-effort: any failure (missing dir, permissions, disk) is swallowed —
 * the audit trail must never break a search.
 *
 * Forward-compat: `route`/`budget`/`round`/`stop_reason`/`decider` fields
 * exist now (Phase 2) and get real values from Phase 3 (budget controller)
 * and Phase 4 (adaptive stopping). Fields stay absent (not null-filled)
 * until producers exist; the aggregator reports observed fields only.
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';

export type AuditLogMode = 'off' | 'on';

export function validateAuditLogMode(value: string): AuditLogMode | null {
  return value === 'off' || value === 'on' ? value : null;
}

export interface RetrievalAuditEntry {
  /** ISO timestamp, local tz. */
  ts: string;
  /** sha256(query) first 12 hex chars — never the raw query. */
  query_hash: string;
  /** resolved search mode (tokenmax, consv, ...). */
  mode?: string;
  /** semantic result-cache posture for this call. */
  cache: 'hit' | 'miss' | 'disabled';
  /** results returned to the caller. */
  hits: number;
  /** full-call wall-clock ms. */
  latency_ms: number;
  /** auto time scope fired: cue + resolved range (Phase 1 producer). */
  temporal?: { cue: string; start: string; end: string };
  /** Phase 3 producer: four-way routing probabilities. */
  route?: Record<string, number>;
  /** Phase 3 producer: integer candidate budget per arm. */
  budget?: Record<string, number>;
  /** Phase 4 producer: retrieve→assess→expand round index. */
  round?: number;
  /** Phase 4 producer: explicit stop reason. */
  stop_reason?: string;
  /** who decided routing/budget: julia | fallback (static baseline) | none. */
  decider: 'julia' | 'fallback' | 'none';
}

/** Privacy-preserving query fingerprint (plan: sha256 prefix 12). */
export function auditQueryHash(query: string): string {
  return createHash('sha256').update(query).digest('hex').slice(0, 12);
}

/** Day-rotated file path for the audit trail. */
export function auditFilePath(baseDir: string, now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return join(baseDir, `retrieval-${y}-${m}-${d}.jsonl`);
}

interface AuditConfig {
  enabled: boolean;
  dir: string;
}

async function resolveAuditConfig(engine: BrainEngine): Promise<AuditConfig | null> {
  try {
    const mode = (await engine.getConfig('search.audit_log').catch(() => null))?.trim();
    if (mode !== 'on') return null;
    const dir = (await engine.getConfig('search.audit_path').catch(() => null))?.trim();
    if (!dir) return null;
    return { enabled: true, dir };
  } catch {
    return null;
  }
}

const dirReady = new Set<string>();

/**
 * Append one decision line. Fire-and-forget by contract: every failure
 * path (config read, mkdir, append) is swallowed so a broken audit disk
 * can never fail or slow a search beyond a failed syscalls' cost.
 */
export async function logRetrievalDecision(engine: BrainEngine, entry: RetrievalAuditEntry): Promise<void> {
  try {
    const cfg = await resolveAuditConfig(engine);
    if (!cfg) return;
    if (!dirReady.has(cfg.dir)) {
      await mkdir(cfg.dir, { recursive: true });
      dirReady.add(cfg.dir);
    }
    await appendFile(auditFilePath(cfg.dir), JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // fail-open by design
  }
}
