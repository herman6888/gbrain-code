/**
 * CJK bigram FTS (v150 port of PMBrain's indexed_cjk_search_tokens).
 *
 * Covers the workorder's four test points on an in-process PGLite brain:
 *   1. Tokenizer: gbrain_cjk_search_tokens emits unigrams + adjacent bigrams.
 *   2. Chinese search hits through the GIN-indexed FTS path (NOT the ILIKE
 *      fallback) — proven with a spy on _searchKeywordCJK: the fallback is
 *      never invoked when the FTS arm returns rows.
 *   3. English FTS regression: the English websearch path still works.
 *   4. Fallback: with a stale (english-only) search_vector the FTS arm
 *      returns zero and the conservative ILIKE safety net (#3986 /
 *      v0.32.7) still finds the chunk — spy confirms it fired.
 *   5. Migration v150 idempotency: re-running the migration SQL on an
 *      existing brain converges without error and keeps search working.
 *
 * NOTE on fallback reachability: under the AND-of-(unigrams+bigrams) FTS
 * semantics, any chunk an ILIKE term-match can find is normally also
 * FTS-matchable, so the fallback only fires on rows whose search_vector
 * missed the CJK lexemes (e.g. written before the migration/backfill).
 * The stale-vector simulation below is the honest way to exercise that arm.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';
import { importFromContent } from '../src/core/import-file.ts';

let engine: PGLiteEngine;
let originalFallback: ((...args: unknown[]) => Promise<unknown>) | undefined;
let fallbackCalls: number;

/** Wrap the private ILIKE fallback so tests can count invocations. */
function installFallbackSpy() {
  fallbackCalls = 0;
  const anyEngine = engine as unknown as {
    _searchKeywordCJK: (...args: unknown[]) => Promise<unknown>;
  };
  originalFallback = anyEngine._searchKeywordCJK;
  anyEngine._searchKeywordCJK = async (...args: unknown[]) => {
    fallbackCalls++;
    return originalFallback!.apply(engine, args);
  };
}

function removeFallbackSpy() {
  if (originalFallback) {
    (engine as unknown as { _searchKeywordCJK: unknown })._searchKeywordCJK = originalFallback;
    originalFallback = undefined;
  }
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await (engine as any).db.exec('DELETE FROM content_chunks');
  await (engine as any).db.exec('DELETE FROM pages');
  installFallbackSpy();
}, 30_000);

afterEach(() => {
  removeFallbackSpy();
});

const CJK_FTS_PREDICATE =
  "search_vector @@ plainto_tsquery('simple', gbrain_cjk_search_tokens($1))";

describe('gbrain_cjk_search_tokens tokenizer', () => {
  test('emits unigrams and adjacent bigrams for 星云项目延期', async () => {
    const rows = await engine.executeRaw<{ tok: string }>(
      'SELECT gbrain_cjk_search_tokens($1) AS tok',
      ['星云项目延期'],
    );
    const toks = rows[0].tok.split(' ');
    // Unigrams
    for (const ch of ['星', '云', '项', '目', '延', '期']) {
      expect(toks).toContain(ch);
    }
    // Adjacent bigrams
    for (const bg of ['星云', '云项', '项目', '目延', '延期']) {
      expect(toks).toContain(bg);
    }
    // Last char has no following bigram; its unigram appears exactly once.
    expect(toks.filter(t => t === '期').length).toBe(1);
  });

  test('non-CJK input yields empty string', async () => {
    const rows = await engine.executeRaw<{ tok: string }>(
      'SELECT gbrain_cjk_search_tokens($1) AS tok',
      ['hello world 123'],
    );
    expect(rows[0].tok).toBe('');
  });

  test('punctuation breaks bigram adjacency (延期，交付 has no 期交 bigram)', async () => {
    const rows = await engine.executeRaw<{ tok: string }>(
      'SELECT gbrain_cjk_search_tokens($1) AS tok',
      ['延期，交付'],
    );
    const toks = rows[0].tok.split(' ');
    expect(toks).toContain('延期');
    expect(toks).toContain('交付');
    expect(toks).not.toContain('期交');
  });
});

describe('Chinese search through bigram FTS', () => {
  test('import 负责人延期交付 → search 延期 hits via FTS, fallback NOT invoked', async () => {
    const md = `---
type: concept
title: 项目周报
---

负责人延期交付，原因是需求变更。`;
    const result = await importFromContent(engine, 'originals/cjk-fts-weekly', md, { noEmbed: true });
    expect(result.status).toBe('imported');
    expect(result.chunks).toBeGreaterThan(0);

    // 1) The stored vector itself satisfies the FTS predicate — the hit is
    //    reachable through the GIN-indexed FTS path.
    const ftsRows = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM content_chunks WHERE ${CJK_FTS_PREDICATE}`,
      ['延期'],
    );
    expect(ftsRows.length).toBeGreaterThan(0);

    // 2) Engine-level search returns the page…
    const hits = await engine.searchKeyword('延期');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].slug).toBe('originals/cjk-fts-weekly');
    // 3) …and the ILIKE fallback was NEVER invoked (FTS served the query).
    expect(fallbackCalls).toBe(0);
  });

  test('multi-char query 星云项目 hits the seeded page via FTS', async () => {
    const md = `---
type: concept
title: 星云计划
---

星云项目于三月启动，预计延期一个季度。`;
    const result = await importFromContent(engine, 'originals/cjk-fts-nebula', md, { noEmbed: true });
    expect(result.status).toBe('imported');

    const hits = await engine.searchKeyword('星云项目');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].slug).toBe('originals/cjk-fts-nebula');
    expect(fallbackCalls).toBe(0);
  });

  test('searchKeywordChunks (chunk-grain primitive) also rides FTS for CJK', async () => {
    const md = `---
type: concept
title: 交付纪要
---

负责人延期交付，会议纪要已归档。`;
    const result = await importFromContent(engine, 'originals/cjk-fts-chunks', md, { noEmbed: true });
    expect(result.status).toBe('imported');

    const hits = await engine.searchKeywordChunks('延期');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].slug).toBe('originals/cjk-fts-chunks');
    expect(fallbackCalls).toBe(0);
  });
});

describe('English FTS regression', () => {
  test('english keyword search unchanged: import + search hits, no CJK path', async () => {
    const md = `---
type: concept
title: Deployment notes
---

The deployment pipeline failed because the migration lock was held.`;
    const result = await importFromContent(engine, 'originals/english-regression', md, { noEmbed: true });
    expect(result.status).toBe('imported');

    const hits = await engine.searchKeyword('deployment pipeline');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].slug).toBe('originals/english-regression');
    // English queries never touch the CJK fallback.
    expect(fallbackCalls).toBe(0);
  });
});

describe('ILIKE fallback safety net', () => {
  test('stale english-only vector: FTS misses, ILIKE fallback still finds it', async () => {
    const md = `---
type: concept
title: 旧数据
---

负责人延期交付，历史遗留行。`;
    const result = await importFromContent(engine, 'originals/cjk-stale', md, { noEmbed: true });
    expect(result.status).toBe('imported');

    // Simulate a row written BEFORE the v150 backfill: overwrite the vector
    // with the pre-v150 english-only expression. The trigger only fires on
    // UPDATE OF chunk_text/doc_comment/symbol_name_qualified, so touching
    // search_vector alone keeps the stale shape.
    await (engine as any).db.exec(`
      UPDATE content_chunks SET search_vector =
        setweight(to_tsvector('english', COALESCE(doc_comment, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(symbol_name_qualified, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(chunk_text, '')), 'B')
    `);

    // FTS arm sees nothing for the CJK query…
    const ftsRows = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM content_chunks WHERE ${CJK_FTS_PREDICATE}`,
      ['延期'],
    );
    expect(ftsRows.length).toBe(0);

    // …but the engine still returns the page via the ILIKE fallback.
    const hits = await engine.searchKeyword('延期');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].slug).toBe('originals/cjk-stale');
    // Spy confirms the fallback path actually fired.
    expect(fallbackCalls).toBe(1);
  });
});

describe('migration v150 idempotency', () => {
  test('v150 exists, is marked idempotent, and re-runs cleanly', async () => {
    const v150 = MIGRATIONS.find(m => m.version === 150);
    expect(v150).toBeDefined();
    expect(v150!.name).toBe('cjk_bigram_fts');
    expect(v150!.idempotent).toBe(true);

    // Seed a row so the backfill UPDATE has work to do, then run the
    // migration SQL twice. Both runs must succeed and the row must stay
    // FTS-matchable afterwards (converged state).
    const md = `---
type: concept
title: 迁移幂等
---

负责人延期交付，验证迁移可重跑。`;
    await importFromContent(engine, 'originals/cjk-migrate-idem', md, { noEmbed: true });

    await engine.runMigration(150, v150!.sql!);
    await engine.runMigration(150, v150!.sql!);

    const hits = await engine.searchKeyword('延期');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].slug).toBe('originals/cjk-migrate-idem');
    // Post-rerun the vector is fresh: FTS served it, fallback untouched.
    expect(fallbackCalls).toBe(0);
  });
});
