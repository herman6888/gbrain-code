/**
 * Segmented page storage (Wave B) DDL shared by migration v248 and both schema
 * blobs (src/schema.sql regions; `bun run build:schema`).
 *
 * The new tables live in the blob; the columns v248 adds to pages,
 * content_chunks and page_versions do not. Those are migration-only, like the
 * trust-tier columns, so a fresh install (blob, then every migration) and an
 * upgraded brain end with the same column order. Blob triggers therefore read
 * `pages.body_generation` / `timeline_lead` only on a row whose body columns
 * are NULL, which v248's DROP NOT NULL is the first to permit.
 */

/**
 * Query-cache generation bump (v0.40.3.0, migration v91's trigger function).
 * BEFORE INSERT OR UPDATE so every write path bumps generation (D6 / codex #4).
 * INSERT: pages get COALESCE(MAX(generation), 0) + 1 so the bookmark gate
 * fires for any cache row stored before the new page existed. UPDATE: bumps
 * only when a content column IS DISTINCT FROM (allow-list widened per D6 +
 * codex #3 to include title/type/page_kind/corpus_generation/content_hash) so
 * read-time mutations don't invalidate every cache row. A segmented page's
 * body identity is `body_generation`: its body columns are NULL on both sides
 * of a flip, so the generation moves when body_generation does.
 */
export const PAGE_GENERATION_BUMP_FN_SQL = `CREATE OR REPLACE FUNCTION bump_page_generation_fn() RETURNS trigger SET search_path = pg_catalog, public AS $func$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    NEW.generation := COALESCE((SELECT MAX(generation) FROM pages), 0) + 1;
  ELSIF (OLD.compiled_truth IS DISTINCT FROM NEW.compiled_truth)
     OR (OLD.timeline IS DISTINCT FROM NEW.timeline)
     OR (OLD.frontmatter IS DISTINCT FROM NEW.frontmatter)
     OR (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
     OR (OLD.contextual_retrieval_mode IS DISTINCT FROM NEW.contextual_retrieval_mode)
     OR (OLD.title IS DISTINCT FROM NEW.title)
     OR (OLD.type IS DISTINCT FROM NEW.type)
     OR (OLD.page_kind IS DISTINCT FROM NEW.page_kind)
     OR (OLD.corpus_generation IS DISTINCT FROM NEW.corpus_generation)
     OR (OLD.content_hash IS DISTINCT FROM NEW.content_hash)
  THEN
    NEW.generation := OLD.generation + 1;
  ELSIF OLD.compiled_truth IS NULL AND NEW.compiled_truth IS NULL THEN
    IF OLD.body_generation IS DISTINCT FROM NEW.body_generation THEN
      NEW.generation := OLD.generation + 1;
    END IF;
  END IF;
  RETURN NEW;
END;
$func$ LANGUAGE plpgsql;`;

/**
 * Segment texts (stored once per source and sha256), the generation-ranged
 * manifest, body stagings and their raw upload parts, and the occurrence id
 * sequence. The manifest's text FK is NO ACTION: a referenced text can't be
 * deleted, and a source delete cascades through pages and texts in one
 * statement before the check runs. The manifest key carries the staging
 * (`staging_key`: the staging id, or the nil uuid once published), so published
 * rows are unique per (page, occurrence, gen_from) and the rows of a staging
 * that never flipped can't collide with the next write's.
 */
export const PAGE_BODY_SCHEMA_SQL = `CREATE SEQUENCE IF NOT EXISTS page_body_occurrence_id_seq;
CREATE TABLE IF NOT EXISTS page_segment_texts (
  source_id  TEXT    NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  sha256     BYTEA   NOT NULL CHECK (octet_length(sha256) = 32),
  byte_len   INTEGER NOT NULL CHECK (byte_len BETWEEN 1 AND 1048576),
  line_count INTEGER NOT NULL CHECK (line_count >= 0),
  body       BYTEA   NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, sha256)
);
CREATE TABLE IF NOT EXISTS page_body_manifest (
  page_id           INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  occurrence_id     BIGINT  NOT NULL,
  gen_from          BIGINT  NOT NULL,
  gen_to            BIGINT,
  seq               INTEGER NOT NULL,
  region            TEXT    NOT NULL CHECK (region IN ('truth','timeline')),
  source_id         TEXT    NOT NULL,
  sha256            BYTEA   NOT NULL,
  byte_start        BIGINT  NOT NULL,
  byte_len          INTEGER NOT NULL,
  line_start        BIGINT  NOT NULL,
  line_count        INTEGER NOT NULL,
  cut_kind          TEXT    NOT NULL CHECK (cut_kind IN ('heading','day','message','blank','forced','region_end','eof')),
  entry_state       JSONB   NOT NULL,
  protected_regions JSONB   NOT NULL DEFAULT '[]',
  facts_slots       JSONB   NOT NULL DEFAULT '[]',
  static_proj_bytes BIGINT  NOT NULL,
  static_proj_lines INTEGER NOT NULL,
  outline           JSONB   NOT NULL DEFAULT '[]',
  date_min          DATE,
  date_max          DATE,
  hash_state        BYTEA   NOT NULL,
  staging_id        UUID,
  staging_key       UUID GENERATED ALWAYS AS (COALESCE(staging_id, '00000000-0000-0000-0000-000000000000'::uuid)) STORED,
  PRIMARY KEY (page_id, occurrence_id, gen_from, staging_key),
  FOREIGN KEY (source_id, sha256) REFERENCES page_segment_texts(source_id, sha256)
);
CREATE UNIQUE INDEX IF NOT EXISTS page_body_manifest_live_seq ON page_body_manifest (page_id, seq) WHERE gen_to IS NULL AND staging_id IS NULL;
CREATE INDEX IF NOT EXISTS page_body_manifest_live_bytes ON page_body_manifest (page_id, byte_start) WHERE gen_to IS NULL;
CREATE INDEX IF NOT EXISTS page_body_manifest_text ON page_body_manifest (source_id, sha256);
CREATE INDEX IF NOT EXISTS page_body_manifest_staging ON page_body_manifest (staging_id) WHERE staging_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS page_body_stagings (
  id                 UUID PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN ('upload','import','sync','put','append','edit','resegment')),
  principal_kind     TEXT NOT NULL,
  principal_id       TEXT NOT NULL,
  client_request_id  UUID NOT NULL,
  source_id          TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  source_incarnation UUID NOT NULL,
  slug               TEXT NOT NULL,
  page_id            INTEGER REFERENCES pages(id) ON DELETE CASCADE,
  mode               TEXT NOT NULL CHECK (mode IN ('create','replace','append')),
  base_revision      UUID,
  base_generation    BIGINT,
  declared_bytes     BIGINT NOT NULL CHECK (declared_bytes >= 0),
  declared_sha256    BYTEA,
  received_bytes     BIGINT NOT NULL DEFAULT 0,
  next_part          INTEGER NOT NULL DEFAULT 0,
  reserved_bytes     BIGINT NOT NULL,
  state              TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','sealed','prepared','committed','aborted','expired')),
  commit_request_id  UUID,
  idle_expires_at    TIMESTAMPTZ NOT NULL,
  hard_expires_at    TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (principal_kind, principal_id, client_request_id)
);
CREATE INDEX IF NOT EXISTS page_body_stagings_expiry ON page_body_stagings (hard_expires_at) WHERE state IN ('open','sealed','prepared');
CREATE TABLE IF NOT EXISTS page_body_staging_parts (
  staging_id UUID    NOT NULL REFERENCES page_body_stagings(id) ON DELETE CASCADE,
  part_no    INTEGER NOT NULL CHECK (part_no >= 0),
  byte_start BIGINT  NOT NULL,
  byte_len   INTEGER NOT NULL CHECK (byte_len BETWEEN 1 AND 4194304),
  sha256     BYTEA   NOT NULL,
  body       BYTEA   NOT NULL,
  PRIMARY KEY (staging_id, part_no)
);`;
