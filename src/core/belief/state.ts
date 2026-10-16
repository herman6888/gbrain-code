/**
 * Raw canonical state of belief streams (docs/designs/BELIEF_LEDGER.md sections 3-4).
 *
 * A stream is one slug of one source: its page, the fence facts it projects
 * (`source_markdown_slug`), the database-only facts about it (`entity_slug`
 * with no `source_markdown_slug`), its takes, and the links and link
 * transitions whose origin (else from) page it is. The finalization contract
 * reads it under the publication's page keys before and after the transaction's
 * projections and diffs the two on logical keys, so projection churn (rows
 * rewritten with identical values, renumbered, re-inserted) yields no event.
 */
import type { BrainEngine } from '../engine.ts';
import { privatePagesFilterFragment } from '../search/private-visibility.ts';
import { PAGE_INLINE_MAX_BYTES } from '../page-size-policy.ts';

export interface RawPage {
  id: number; slug: string; deleted: boolean; revision: string; content_hash: string | null; tier: string;
  visible: boolean; large: boolean; incarnation: string;
}
export interface RawFact {
  id: number; entity_slug: string | null; sms: string | null; entity_page_id: number | null; fact: string; fp: string;
  kind: string; visibility: string; notability: string; context: string | null; confidence: number;
  valid_from: string | null; valid_until: string | null; claim_metric: string | null; claim_value: number | null;
  claim_unit: string | null; claim_period: string | null; event_type: string | null; dimension: string | null;
  value: string | null; value_hash: string | null; row_num: number | null; tier: string;
}
export interface RawTake {
  id: number; page_id: number; row_num: number; claim: string; claim_fp: string; kind: string; holder: string; weight: number;
  since_date: string | null; until_date: string | null; source: string | null; active: boolean;
  resolved_at: string | null; resolved_outcome: boolean | null; resolved_value: number | null; resolved_unit: string | null;
  resolved_source: string | null; resolved_by: string | null; resolved_quality: string | null; tier: string;
}
export interface RawEndpoint { id: number; slug: string; source_id: string; incarnation: string }
export interface RawLink {
  id: number; from: RawEndpoint; to: RawEndpoint; origin: RawEndpoint | null; link_type: string; link_source: string | null;
  context: string; origin_field: string | null; link_kind: string | null; resolution_type: string | null; assertion_tense: string | null;
}
export interface RawTransition {
  id: number; from: RawEndpoint; to: RawEndpoint; origin: RawEndpoint | null; link_type: string; kind: string;
  occurred_on: string; date_precision: string; producer: string; line_hash: string;
}
export interface RawState { pages: RawPage[]; facts: RawFact[]; takes: RawTake[]; links: RawLink[]; transitions: RawTransition[]; writerTier: string | null }

const iso = (value: unknown): string | null => value == null ? null : new Date(value as string).toISOString();
const num = (value: unknown): number | null => value == null ? null : Number(value);

const ENDS = 'from_page_id, to_page_id, origin_page_id';
/**
 * The rows a page set owns (its origin, or its from-page when it has no origin), as two index scans. Kept as a
 * subquery with OFFSET 0 so the planner drives the endpoint joins from these few rows instead of joining pages first.
 */
const OWNED_ROWS = (table: 'links' | 'link_transitions', ids: string, columns = '*') => `SELECT ${columns} FROM ${table} WHERE origin_page_id = ANY(${ids})
  UNION ALL SELECT ${columns} FROM ${table} WHERE origin_page_id IS NULL AND from_page_id = ANY(${ids}) OFFSET 0`;

/**
 * One pipeline of five reads. `slugs` select the stream pages and the facts
 * keyed to them; `pageIds` add pages by id (a renamed page is found at its new
 * slug); `factIds`/`takeIds` add rows a guard named that live in another stream.
 */
export async function readBeliefState(tx: BrainEngine, sourceId: string, slugs: readonly string[], pageIds: readonly number[] = [], known?: RawState): Promise<RawState> {
  // One statement: each part selects the batch's pages itself ($1 source, $2 slugs, $3 page ids) and returns its rows as JSON.
  // Fingerprints of claim texts `known` (the batch's pre-read) already has are not recomputed: the SQL fingerprint
  // is most of a large page's read. The statement runs with a generic plan (restored after): under the default
  // plan_cache_mode a bulk import re-plans it for every page as the tables grow (about 3 ms each, rising with size).
  const knownFp = new Map<string, string>([...(known?.facts ?? []).map(f => [f.fact, f.fp] as const), ...(known?.takes ?? []).map(k => [k.claim, k.claim_fp] as const)]);
  const params = [sourceId, [...slugs], [...pageIds], [...knownFp.keys()]];
  const STREAM_SLUGS = `$2::text[] || ARRAY(SELECT p.slug FROM pages p WHERE p.source_id = $1 AND p.id = ANY($3::int[]))`;
  const PAGE_IDS = `ARRAY(SELECT p.id FROM pages p WHERE p.source_id = $1 AND (p.slug = ANY($2::text[]) OR p.id = ANY($3::int[])))`;
  const [mode] = await tx.executeRaw<{ prev: string }>(`SELECT current_setting('plan_cache_mode') AS prev, set_config('plan_cache_mode', 'force_generic_plan', true)`);
  const [row] = await tx.executeRaw<Record<string, Record<string, unknown>[]>>(`SELECT
    (SELECT COALESCE(json_agg(q), '[]'::json) FROM (
SELECT p.id, p.slug, p.deleted_at IS NOT NULL AS deleted, p.knowledge_revision::text AS revision,
      p.content_hash, p.trust_tier, (${privatePagesFilterFragment('p')}) AS visible, s.incarnation::text AS incarnation,
      (p.body_storage = 'segmented' OR octet_length(COALESCE(p.compiled_truth,'')) + octet_length(COALESCE(p.timeline,'')) > ${PAGE_INLINE_MAX_BYTES}) AS large,
      current_setting('gbrain.write_trust_tier', true) AS writer_tier
    FROM pages p JOIN sources s ON s.id = p.source_id
    WHERE p.source_id = $1 AND (p.slug = ANY($2::text[]) OR p.id = ANY($3::int[]))) q) AS pages,
    (SELECT COALESCE(json_agg(q), '[]'::json) FROM (
SELECT f.id, f.entity_slug, f.source_markdown_slug AS sms, pe.id AS entity_page_id, f.fact,
        CASE WHEN f.fact = ANY($4::text[]) THEN NULL ELSE gbrain_fact_fingerprint(f.fact) END AS fp, f.kind, f.visibility, f.notability, f.context, f.confidence::text AS confidence,
        f.valid_from, f.valid_until, f.claim_metric, f.claim_value::text AS claim_value, f.claim_unit, f.claim_period, f.event_type,
        f.dimension, f.value, f.value_hash, f.row_num, f.trust_tier
      FROM (SELECT * FROM facts WHERE source_id = $1 AND expired_at IS NULL AND source_markdown_slug = ANY(${STREAM_SLUGS})
        UNION ALL SELECT * FROM facts WHERE source_id = $1 AND expired_at IS NULL AND source_markdown_slug IS NULL AND entity_slug = ANY(${STREAM_SLUGS})) f
        LEFT JOIN pages pe ON pe.source_id = f.source_id AND pe.slug = f.entity_slug) q) AS facts,
    (SELECT COALESCE(json_agg(q), '[]'::json) FROM (
SELECT k.id, k.page_id, k.row_num, k.claim, CASE WHEN k.claim = ANY($4::text[]) THEN NULL ELSE gbrain_fact_fingerprint(k.claim) END AS claim_fp,
        k.kind, k.holder, k.weight::text AS weight, k.since_date, k.until_date, k.source, k.active, k.resolved_at, k.resolved_outcome,
        k.resolved_value::text AS resolved_value, k.resolved_unit, k.resolved_source, k.resolved_by, k.resolved_quality, k.trust_tier
      FROM takes k WHERE k.page_id = ANY(${PAGE_IDS})) q) AS takes,
    (SELECT COALESCE(json_agg(q), '[]'::json) FROM (
SELECT l.id, l.from_page_id AS f, l.to_page_id AS t, l.origin_page_id AS o,
        l.link_type, l.link_source, l.context, l.origin_field, l.link_kind, l.resolution_type, l.assertion_tense
      FROM (${OWNED_ROWS('links', PAGE_IDS)}) l) q) AS links,
    (SELECT COALESCE(json_agg(q), '[]'::json) FROM (
SELECT x.id, x.from_page_id AS f, x.to_page_id AS t, x.origin_page_id AS o,
        x.link_type, x.kind, x.occurred_on::text AS occurred_on, x.date_precision, x.producer, x.line_hash
      FROM (${OWNED_ROWS('link_transitions', PAGE_IDS)}) x) q) AS transitions,
    (SELECT COALESCE(json_agg(q), '[]'::json) FROM (
SELECT p.id, p.slug, p.source_id, s.incarnation::text AS incarnation FROM pages p JOIN sources s ON s.id = p.source_id
      WHERE p.id = ANY(ARRAY(SELECT unnest(ARRAY[e.from_page_id, e.to_page_id, e.origin_page_id])
        FROM ((${OWNED_ROWS('links', PAGE_IDS, ENDS)}) UNION ALL (${OWNED_ROWS('link_transitions', PAGE_IDS, ENDS)})) e))) q) AS endpoints`, params);
  await tx.executeRaw(`SELECT set_config('plan_cache_mode', $1, true)`, [mode!.prev]);
  const { pages: pageRows, facts, takes, links, transitions, endpoints } = row!;
  const byId = new Map(endpoints.map(r => [Number(r.id), { id: Number(r.id), slug: String(r.slug), source_id: String(r.source_id), incarnation: String(r.incarnation) }]));
  const endpoint = (id: unknown): RawEndpoint | null => id == null ? null : byId.get(Number(id)) ?? null;
  const pages: RawPage[] = pageRows.map(r => ({ id: Number(r.id), slug: String(r.slug), deleted: r.deleted === true, revision: String(r.revision),
    content_hash: (r.content_hash as string | null) ?? null, tier: String(r.trust_tier), visible: r.visible === true, large: r.large === true,
    incarnation: String(r.incarnation) }));
  return {
    pages,
    facts: facts.map(r => toFact(r.fp == null ? { ...r, fp: knownFp.get(String(r.fact)) } : r)),
    takes: takes.map(r => toTake(r.claim_fp == null ? { ...r, claim_fp: knownFp.get(String(r.claim)) } : r)),
    links: links.map(r => ({ id: Number(r.id), from: endpoint(r.f)!, to: endpoint(r.t)!, origin: endpoint(r.o), link_type: String(r.link_type),
      link_source: (r.link_source as string | null) ?? null, context: String(r.context ?? ''), origin_field: (r.origin_field as string | null) ?? null,
      link_kind: (r.link_kind as string | null) ?? null, resolution_type: (r.resolution_type as string | null) ?? null,
      assertion_tense: (r.assertion_tense as string | null) ?? null })),
    transitions: transitions.map(r => ({ id: Number(r.id), from: endpoint(r.f)!, to: endpoint(r.t)!, origin: endpoint(r.o),
      link_type: String(r.link_type), kind: String(r.kind), occurred_on: String(r.occurred_on), date_precision: String(r.date_precision),
      producer: String(r.producer), line_hash: String(r.line_hash) })),
    writerTier: ((pageRows[0] ?? (await tx.executeRaw<Record<string, unknown>>(`SELECT current_setting('gbrain.write_trust_tier', true) AS writer_tier`))[0])
      ?.writer_tier as string | undefined) || null,
  };
}

/** Rows by id, for a guard event whose row lives outside the batch's streams. */
export async function readFactsById(tx: BrainEngine, ids: readonly number[]): Promise<RawFact[]> {
  if (!ids.length) return [];
  const rows = await tx.executeRaw<Record<string, unknown>>(`SELECT f.id, f.entity_slug, f.source_markdown_slug AS sms, pe.id AS entity_page_id, f.fact,
      gbrain_fact_fingerprint(f.fact) AS fp, f.kind, f.visibility, f.notability, f.context, f.confidence::text AS confidence,
      f.valid_from, f.valid_until, f.claim_metric, f.claim_value::text AS claim_value, f.claim_unit, f.claim_period, f.event_type,
      f.dimension, f.value, f.value_hash, f.row_num, f.trust_tier
    FROM facts f LEFT JOIN pages pe ON pe.source_id = f.source_id AND pe.slug = f.entity_slug WHERE f.id = ANY($1::bigint[])`, [[...ids]]);
  return rows.map(toFact);
}

function toFact(r: Record<string, unknown>): RawFact {
  return { id: Number(r.id), entity_slug: (r.entity_slug as string | null) ?? null, sms: (r.sms as string | null) ?? null,
    entity_page_id: num(r.entity_page_id), fact: String(r.fact), fp: String(r.fp), kind: String(r.kind), visibility: String(r.visibility),
    notability: String(r.notability), context: (r.context as string | null) ?? null, confidence: Number(r.confidence),
    valid_from: iso(r.valid_from), valid_until: iso(r.valid_until), claim_metric: (r.claim_metric as string | null) ?? null,
    claim_value: num(r.claim_value), claim_unit: (r.claim_unit as string | null) ?? null, claim_period: (r.claim_period as string | null) ?? null,
    event_type: (r.event_type as string | null) ?? null, dimension: (r.dimension as string | null) ?? null, value: (r.value as string | null) ?? null,
    value_hash: (r.value_hash as string | null) ?? null, row_num: num(r.row_num), tier: String(r.trust_tier) };
}

function toTake(r: Record<string, unknown>): RawTake {
  return { id: Number(r.id), page_id: Number(r.page_id), row_num: Number(r.row_num), claim: String(r.claim), claim_fp: String(r.claim_fp),
    kind: String(r.kind), holder: String(r.holder), weight: Number(r.weight), since_date: (r.since_date as string | null) ?? null,
    until_date: (r.until_date as string | null) ?? null, source: (r.source as string | null) ?? null, active: r.active === true,
    resolved_at: iso(r.resolved_at), resolved_outcome: (r.resolved_outcome as boolean | null) ?? null, resolved_value: num(r.resolved_value),
    resolved_unit: (r.resolved_unit as string | null) ?? null, resolved_source: (r.resolved_source as string | null) ?? null,
    resolved_by: (r.resolved_by as string | null) ?? null, resolved_quality: (r.resolved_quality as string | null) ?? null, tier: String(r.trust_tier) };
}
