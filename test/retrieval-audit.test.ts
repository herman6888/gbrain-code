import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  auditQueryHash,
  auditFilePath,
  logRetrievalDecision,
  validateAuditLogMode,
  type RetrievalAuditEntry,
} from '../src/core/search/retrieval-audit.ts';

function mockEngine(config: Record<string, string>) {
  return {
    getConfig: async (key: string) => config[key] ?? null,
  } as never;
}

const baseEntry: RetrievalAuditEntry = {
  ts: '2026-10-19T10:00:00.000Z',
  query_hash: auditQueryHash('上周 WOL 修复'),
  cache: 'miss',
  hits: 10,
  latency_ms: 1234,
  decider: 'none',
};

describe('retrieval audit', () => {
  test('validate mode', () => {
    expect(validateAuditLogMode('on')).toBe('on');
    expect(validateAuditLogMode('off')).toBe('off');
    expect(validateAuditLogMode('yes')).toBeNull();
  });
  test('query hash: stable, 12 hex, never the raw text', () => {
    const h = auditQueryHash('上周 WOL 修复');
    expect(h).toMatch(/^[0-9a-f]{12}$/);
    expect(h).toBe(auditQueryHash('上周 WOL 修复'));
    expect(auditQueryHash('别的')).not.toBe(h);
  });
  test('day rotation path', () => {
    expect(auditFilePath('/tmp/a', new Date(2026, 9, 19, 23, 59))).toBe('/tmp/a/retrieval-2026-10-19.jsonl');
  });
  test('off by default: no file written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-'));
    await logRetrievalDecision(mockEngine({}), baseEntry);
    expect(readdirSync(dir)).toHaveLength(0);
  });
  test('on: appends one JSON line per decision, with Phase 3/4 fields forward-compat', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-'));
    const engine = mockEngine({ 'search.audit_log': 'on', 'search.audit_path': dir });
    await logRetrievalDecision(engine, { ...baseEntry, mode: 'tokenmax' });
    await logRetrievalDecision(engine, {
      ...baseEntry, temporal: { cue: '上周', start: '2026-10-12', end: '2026-10-18' },
      route: { temporal: 0.9, semantic: 0.1 }, budget: { temporal: 30, semantic: 10 },
      round: 2, stop_reason: 'evidence_sufficient', decider: 'julia',
    });
    const files = readdirSync(dir);
    const d = new Date();
    const expected = `retrieval-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.jsonl`;
    expect(files).toEqual([expected]); // today's day-rotated file
    const lines = readFileSync(join(dir, files[0]), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first.mode).toBe('tokenmax');
    expect(first.query_hash).toHaveLength(12);
    expect('上周 WOL 修复' in first).toBe(false);
    const second = JSON.parse(lines[1]);
    expect(second.temporal.cue).toBe('上周');
    expect(second.stop_reason).toBe('evidence_sufficient');
    expect(second.decider).toBe('julia');
  });
  test('fail-open: unwritable path never throws', async () => {
    const engine = mockEngine({ 'search.audit_log': 'on', 'search.audit_path': '/proc/no-such-dir/audit' });
    await logRetrievalDecision(engine, baseEntry); // must not throw
    expect(true).toBe(true);
  });
});
