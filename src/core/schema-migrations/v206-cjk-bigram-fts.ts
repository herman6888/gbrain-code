import type { Migration } from './types.ts';

export const v206: Migration = {
  // Local fork patch (renumbered v150→v184→v187→v204→v206 (v204 claimed by upstream links-temporal-state in v0.60.61.0) —
  // upstream claimed v150 for canonical_page_revisions_and_guards).
  // Chinese-first search (PMBrain v109 port): extend the existing
  // GIN-backed content_chunks.search_vector with CJK unigram +
  // adjacent-bigram lexemes so CJK keyword queries ride the indexed
  // FTS path instead of the full-table ILIKE scan. English lexemes and
  // ranking weights stay unchanged. Idempotent: CREATE OR REPLACE for
  // both functions, DROP TRIGGER IF EXISTS before re-create, and the
  // backfill recomputes search_vector from the source columns, so a
  // re-run converges to the same state.
  version: 206,
  name: 'cjk_bigram_fts',
  idempotent: true,
  sql: `
      CREATE OR REPLACE FUNCTION gbrain_cjk_search_tokens(input_text TEXT) RETURNS TEXT
      LANGUAGE SQL IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $cjkfn$
        WITH chars AS (
          SELECT ch, ord
          FROM regexp_split_to_table(COALESCE(input_text, ''), '') WITH ORDINALITY AS t(ch, ord)
          WHERE ch ~ '[一-鿿぀-ゟ゠-ヿ가-힯]'
        )
        SELECT COALESCE(string_agg(
          CASE WHEN next_char.ch IS NOT NULL
            THEN current_char.ch || ' ' || current_char.ch || next_char.ch
            ELSE current_char.ch
          END,
          ' ' ORDER BY current_char.ord
        ), '')
        FROM chars current_char
        LEFT JOIN chars next_char ON next_char.ord = current_char.ord + 1
      $cjkfn$;

      CREATE OR REPLACE FUNCTION update_chunk_search_vector() RETURNS TRIGGER SET search_path = pg_catalog, public AS $cjktrg$
      BEGIN
        NEW.search_vector :=
          setweight(to_tsvector('english', COALESCE(NEW.doc_comment, '')), 'A') ||
          setweight(to_tsvector('english', COALESCE(NEW.symbol_name_qualified, '')), 'A') ||
          setweight(to_tsvector('english', COALESCE(NEW.chunk_text, '')), 'B') ||
          setweight(to_tsvector('simple', gbrain_cjk_search_tokens(COALESCE(NEW.doc_comment, ''))), 'A') ||
          setweight(to_tsvector('simple', gbrain_cjk_search_tokens(COALESCE(NEW.symbol_name_qualified, ''))), 'A') ||
          setweight(to_tsvector('simple', gbrain_cjk_search_tokens(COALESCE(NEW.chunk_text, ''))), 'B');
        RETURN NEW;
      END;
      $cjktrg$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS chunk_search_vector_trigger ON content_chunks;
      CREATE TRIGGER chunk_search_vector_trigger
        BEFORE INSERT OR UPDATE OF chunk_text, doc_comment, symbol_name_qualified
        ON content_chunks
        FOR EACH ROW EXECUTE FUNCTION update_chunk_search_vector();

      UPDATE content_chunks
      SET search_vector =
        setweight(to_tsvector('english', COALESCE(doc_comment, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(symbol_name_qualified, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(chunk_text, '')), 'B') ||
        setweight(to_tsvector('simple', gbrain_cjk_search_tokens(COALESCE(doc_comment, ''))), 'A') ||
        setweight(to_tsvector('simple', gbrain_cjk_search_tokens(COALESCE(symbol_name_qualified, ''))), 'A') ||
        setweight(to_tsvector('simple', gbrain_cjk_search_tokens(COALESCE(chunk_text, ''))), 'B')
      WHERE chunk_text IS NOT NULL;
    `,
};
