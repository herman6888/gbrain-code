/**
 * #6143: the base-schema replay (PostgresEngine.initSchema) is one implicit transaction that takes ACCESS EXCLUSIVE
 * locks as it goes, pages' triggers long before sources' managed_writer_guard. A live reader that holds sources and then
 * reads pages (the resident persistence consumer's idle probe did, on the nightly arm) closes a cycle with it, and
 * Postgres aborts the replay with deadlock_detected. The replay rolls back whole, so initSchema runs it again.
 * Forced: a reader transaction takes sources, waits until the replay is queued on sources, then reads pages. Postgres only.
 */
import { describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

describe.skipIf(!testBackends().includes('postgres'))('#6143 schema replay against a live reader', () => {
  test('a reader that holds sources and then reads pages no longer fails the replay with a deadlock', async () => {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    const reader = postgres(pg.databaseUrl, { max: 1, onnotice: () => {} });
    const watcher = postgres(pg.databaseUrl, { max: 1, onnotice: () => {} });
    try {
      let replay: Promise<unknown> | undefined;
      await reader.begin(async sql => {
        await sql`SELECT 1 FROM sources LIMIT 1`;
        replay = pg.engine.initSchema().then(() => 'ok', (error: { code?: string; message?: string }) => `${error.code ?? ''} ${error.message ?? error}`);
        for (let i = 0; i < 400; i++) {
          const [row] = await watcher<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND relation = 'sources'::regclass`;
          if (row!.n > 0) break;
          await Bun.sleep(25);
        }
        await sql`SELECT 1 FROM pages LIMIT 1`;
      });
      expect(await replay).toBe('ok');
      expect(await pg.engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'managed_writer_guard' AND tgrelid = 'sources'::regclass")).toEqual([{ n: 1 }]);
    } finally { await reader.end(); await watcher.end(); await pg.close(); }
  }, 120_000);
});
