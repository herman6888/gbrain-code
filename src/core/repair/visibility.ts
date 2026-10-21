/**
 * `gbrain repair visibility` (#5525): tighten-only backfill that stamps an
 * explicit `visibility` on extracted atoms and synthesized concepts.
 *
 *   atom     origin page -> effectiveVisibility(origin); transcript or missing origin -> private
 *   concept  strictest visibility of its input atoms (provenance edges + atoms' `concepts:`);
 *            a member without a provenance edge counts as private
 *
 *   event    a Life Chronicle event whose meeting/conversation origin is private now (by its
 *            `visibility`, lineage or a privacy alias) becomes private; a missing origin is
 *            left unchanged and counted (remote reads already hide it)
 *   alias    a page that carries a privacy alias (`access: private`, ...) but no `visibility`
 *            is stamped `visibility: private`
 *   fact     an active world fact held in or extracted from such a private page becomes
 *            private: in its page's facts fence when fenced, in place when database-only
 *
 * An item is only ever made stricter than it is now: explicit `private` stays,
 * explicit `world` becomes `private` when its origin is stricter, and a missing
 * field (read as private) is stamped with the origin's value. A concept with no
 * recoverable lineage is left unchanged and counted. Atoms are applied before
 * concepts so a concept is judged against its repaired inputs.
 */
import type { BrainEngine } from '../engine.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { submitPageMutation } from '../persistence/page-mutations.ts';
import { derivationPrivateSql, effectiveVisibility, privacyAliasSql, privateSnapshotFilterFragment, strictestVisibility, type Visibility } from '../search/private-visibility.ts';
import { strikeFenceRow } from '../facts/forget.ts';
import { opError } from '../ops/contract.ts';
import { authorizeWrite } from '../persistence/authority.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import { digest } from '../persistence/digest.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { maintenancePreflight, submitDatabaseMaintenanceIntent } from '../persistence/prepared-maintenance.ts';
import { isSegmentedPage } from '../page-body/page-shape.ts';
import { afterCursor, repairRequestId, type RepairHandler, type RepairItem, type RepairScope, type RepairCursor } from './core.ts';

interface DerivedRow { id: number; source_id: string; slug: string; type: string; visibility: string | null; chars: number }
interface AtomRow extends DerivedRow { source_slug: string | null; origin_id: number | null; origin_type: string | null; origin_frontmatter: Record<string, unknown> | null }
interface InputRow { concept_id: number; atom_id: number; linked: boolean }

interface EventRow extends DerivedRow { origin_id: number | null; origin_type: string | null; origin_frontmatter: Record<string, unknown> | null }

export interface VisibilityChange { id: number; source_id: string; slug: string; phase: 0 | 1 | 2 | 3; from: string | null; to: Visibility }

/** Tighten-only: never loosen an explicit value; stamp a missing one. */
function tightened(current: string | null, target: Visibility): Visibility | null {
  if (current === 'private') return null;
  if (current === 'world') return target === 'private' ? 'private' : null;
  return target;
}

/**
 * Every atom / synthesized concept in scope whose stored visibility should
 * change. `only` narrows the plan to one page (and, for a concept, its inputs)
 * so an item is re-decided against current state just before it is applied.
 */
export async function planVisibilityRepair(engine: BrainEngine, sourceIds: string[], only?: number) {
  const [kind] = only === undefined ? [] : await engine.executeRaw<{ type: string }>('SELECT type FROM pages WHERE id=$1', [only]);
  const conceptIds = only === undefined ? null : kind?.type === 'concept' ? [only] : [];
  const eventIds = only === undefined ? null : kind?.type === 'event' ? [only] : [];
  const concepts = await engine.executeRaw<DerivedRow>(`SELECT c.id,c.source_id,c.slug,c.type,c.frontmatter->>'visibility' AS visibility,
      length(c.compiled_truth) AS chars
    FROM pages c WHERE c.type='concept' AND c.frontmatter->>'synthesized_by' IS NOT NULL AND c.deleted_at IS NULL
      AND c.source_id=ANY($1::text[]) AND ($2::integer[] IS NULL OR c.id=ANY($2::integer[])) ORDER BY c.id`, [sourceIds, conceptIds]);
  // A member recovered only from an atom's `concepts:` list has no provenance
  // edge, so a later private flip could not reach the concept: it stays private.
  const inputs = concepts.length ? await engine.executeRaw<InputRow>(`SELECT c.id AS concept_id,a.id AS atom_id,
      EXISTS (SELECT 1 FROM links l WHERE l.from_page_id=c.id AND l.to_page_id=a.id
        AND l.link_source='concept-provenance' AND l.link_type='synthesized_from') AS linked
    FROM pages c JOIN pages a ON a.source_id=c.source_id AND a.type='atom' AND a.deleted_at IS NULL
    WHERE c.id=ANY($1::integer[]) AND (
      EXISTS (SELECT 1 FROM links l WHERE l.from_page_id=c.id AND l.to_page_id=a.id
        AND l.link_source='concept-provenance' AND l.link_type='synthesized_from')
      OR (jsonb_typeof(a.frontmatter->'concepts')='array' AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(a.frontmatter->'concepts') ref
        WHERE regexp_replace(ref,'^.*/','')=regexp_replace(c.slug,'^concepts/',''))))`, [concepts.map(c => Number(c.id))]) : [];
  const atomIds = only === undefined ? null : kind?.type === 'atom' ? [only] : inputs.map(row => Number(row.atom_id));
  const atoms = await engine.executeRaw<AtomRow>(`SELECT a.id,a.source_id,a.slug,a.type,a.frontmatter->>'visibility' AS visibility,
      length(a.compiled_truth) AS chars, a.frontmatter->>'source_slug' AS source_slug,
      o.id AS origin_id,o.type AS origin_type,o.frontmatter AS origin_frontmatter
    FROM pages a LEFT JOIN pages o ON o.source_id=a.source_id AND o.slug=a.frontmatter->>'source_slug' AND o.deleted_at IS NULL
    WHERE a.type='atom' AND a.deleted_at IS NULL AND a.source_id=ANY($1::text[])
      AND ($2::integer[] IS NULL OR a.id=ANY($2::integer[])) ORDER BY a.id`, [sourceIds, atomIds]);

  const changes: VisibilityChange[] = [];
  const atomVisibility = new Map<number, Visibility>();
  let originGone = 0;
  for (const atom of atoms) {
    const origin = atom.source_slug ? { kind: 'page' as const, page: atom.origin_id == null ? null : { type: atom.origin_type, frontmatter: atom.origin_frontmatter } }
      : { kind: 'transcript' as const };
    const target = effectiveVisibility(origin);
    const next = tightened(atom.visibility, target);
    if (next && origin.kind === 'page' && !origin.page) originGone++;
    const effective = next ?? (atom.visibility === 'world' ? 'world' : 'private');
    atomVisibility.set(Number(atom.id), effective);
    if (next) changes.push({ id: Number(atom.id), source_id: atom.source_id, slug: atom.slug, phase: 0, from: atom.visibility, to: next });
  }
  let noLineage = 0;
  for (const concept of concepts) {
    const rows = inputs.filter(row => Number(row.concept_id) === Number(concept.id));
    if (!rows.length) { noLineage++; continue; }
    const members = rows.map(row => row.linked ? atomVisibility.get(Number(row.atom_id)) ?? 'private' : 'private');
    const next = tightened(concept.visibility, strictestVisibility(members));
    if (next) changes.push({ id: Number(concept.id), source_id: concept.source_id, slug: concept.slug, phase: 1, from: concept.visibility, to: next });
  }
  const events = await engine.executeRaw<EventRow>(`SELECT e.id,e.source_id,e.slug,e.type,e.frontmatter->>'visibility' AS visibility,
      length(e.compiled_truth) AS chars,o.id AS origin_id,o.type AS origin_type,o.frontmatter AS origin_frontmatter
    FROM pages e LEFT JOIN pages o ON o.source_id=e.source_id AND o.slug=e.frontmatter->'event'->>'depth' AND o.deleted_at IS NULL
    WHERE e.type='event' AND e.frontmatter->>'captured_via' LIKE 'life-chronicle:%' AND e.deleted_at IS NULL
      AND COALESCE(e.frontmatter->>'visibility','world')<>'private'
      AND e.source_id=ANY($1::text[]) AND ($2::integer[] IS NULL OR e.id=ANY($2::integer[])) ORDER BY e.id`, [sourceIds, eventIds]);
  let eventsOriginGone = 0;
  for (const event of events) {
    if (event.origin_id == null) { eventsOriginGone++; continue; }
    if (effectiveVisibility({ kind: 'page', page: { type: event.origin_type, frontmatter: event.origin_frontmatter } }) !== 'private') continue;
    changes.push({ id: Number(event.id), source_id: event.source_id, slug: event.slug, phase: 2, from: event.visibility, to: 'private' });
  }
  const aliased = await engine.executeRaw<DerivedRow>(`SELECT p.id,p.source_id,p.slug,p.type,NULL::text AS visibility,length(p.compiled_truth) AS chars
    FROM pages p WHERE ${aliasOnlyPagesSql('p')} AND p.source_id=ANY($1::text[]) AND ($2::integer[] IS NULL OR p.id=ANY($2::integer[])) ORDER BY p.id`,
  [sourceIds, only === undefined ? null : [only]]);
  for (const page of aliased) changes.push({ id: Number(page.id), source_id: page.source_id, slug: page.slug, phase: 3, from: null, to: 'private' });
  const chars = new Map([...atoms, ...concepts, ...events, ...aliased].map(row => [Number(row.id), Number(row.chars)]));
  return { changes, chars, residuals: { atoms_origin_gone_to_private: originGone, concepts_without_lineage: noLineage,
    events_origin_gone: eventsOriginGone } };
}

/**
 * The page a fact says it came from (not the page holding it): the page-write
 * session (`put_page:<slug>`, `sync:<slug>`), else the slug a page-write or
 * extract_facts lane records first in `context`.
 */
function factProvenanceSlugSql(f: string): string {
  return `regexp_replace(COALESCE(
    CASE WHEN ${f}.source_session ~ '^(put_page|sync):' THEN regexp_replace(${f}.source_session, '^(put_page|sync):', '') END,
    CASE WHEN ${f}.source IN ('mcp:put_page','sync:import','file_upload','code_import','hook:writeback','mcp:extract_facts')
      THEN NULLIF(split_part(btrim(COALESCE(${f}.context,'')), ' ', 1), '') END), '\\.md$', '')`;
}

/**
 * Active `world` facts held in, or extracted from, a page that is private by
 * its `visibility`, its declared lineage or a privacy alias. `readable` says a
 * remote caller can recall the row today: its holding page does not hide it
 * through the provenance filter.
 */
export async function worldFactsFromPrivateSources(engine: BrainEngine, sourceIds: string[], ids?: number[]) {
  return engine.executeRaw<{ id: number; source_id: string; row_num: number | null; source_markdown_slug: string | null; entity_slug: string | null; readable: boolean }>(
    `SELECT f.id,f.source_id,f.row_num,f.source_markdown_slug,f.entity_slug,
      (f.source_markdown_slug IS NULL OR NOT EXISTS (SELECT 1 FROM pages pp WHERE pp.source_id=f.source_id
        AND pp.slug=f.source_markdown_slug AND NOT ${privateSnapshotFilterFragment('pp')})) AS readable
    FROM facts f WHERE f.visibility='world' AND f.expired_at IS NULL AND f.source_id=ANY($1::text[])
      AND ($2::bigint[] IS NULL OR f.id=ANY($2::bigint[]))
      AND EXISTS (SELECT 1 FROM pages o WHERE o.source_id=f.source_id AND o.deleted_at IS NULL
        AND (o.slug=f.source_markdown_slug OR o.slug=${factProvenanceSlugSql('f')}) AND ${derivationPrivateSql('o')})
    ORDER BY f.id`, [sourceIds, ids ?? null]);
}

/** Pages that carry a privacy alias but no `visibility` (derived atoms, concepts and chronicle events have their own phases). */
export function aliasOnlyPagesSql(p: string): string {
  return `(${p}.deleted_at IS NULL AND ${p}.frontmatter->>'visibility' IS NULL AND ${privacyAliasSql(p)}
    AND ${p}.type <> 'atom' AND NOT (${p}.type = 'concept' AND ${p}.frontmatter->>'synthesized_by' IS NOT NULL)
    AND NOT (${p}.type = 'event' AND ${p}.frontmatter->>'captured_via' LIKE 'life-chronicle:%'))`;
}

export const FACT_VISIBILITY_INTENT = 'managed_maintenance_tighten_fact_visibility';

/** Database-only rows still world and unfenced become private; the compare runs in the UPDATE, which locks the row. */
const tightenDatabaseFacts = (tx: BrainEngine, sourceId: string, ids: number[]) => tx.executeRaw<{ id: number | string }>(
  `UPDATE facts SET visibility='private' WHERE source_id=$1 AND id=ANY($2::bigint[]) AND visibility='world' AND row_num IS NULL AND expired_at IS NULL RETURNING id`,
  [sourceId, ids]);

/** Preparer for `managed_maintenance_tighten_fact_visibility`: makes the named database-only world facts private. */
export async function prepareFactVisibilityTighten(engine: BrainEngine, row: WriteRequest): Promise<PreparedMutation> {
  const ids = (row.intent as { fact_ids?: unknown } | null)?.fact_ids;
  if (!Array.isArray(ids) || !ids.every(id => Number.isSafeInteger(id))) {
    throw opError('invalid_params', 'The fact visibility intent does not name its facts.',
      `Request ${row.request_id} in source ${row.source_id} does not name the facts to make private, so nothing changed. Preview gbrain repair visibility again and apply it after the user approves.`);
  }
  await authorizeWrite(engine, row.authority, 'submit_job', row.slug);
  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
  return { observedRevision: snapshot?.revision ?? null, noop: true,
    validate: async tx => { await authorizeWrite(tx, row.authority, 'submit_job', row.slug); },
    apply: async tx => ({ status: 'completed', tightened: (await tightenDatabaseFacts(tx, row.source_id, ids as number[])).map(r => Number(r.id)) }) };
}

/**
 * One fact item: a fenced row gets `private` in its page's `## Facts` fence by a
 * revision-bound put_page (the projection then stores it private); a
 * database-only row is updated in place (a database-only maintenance request
 * on a managed brain). A page stored in segments is left for the owner.
 */
async function applyFactItem(ctx: Parameters<RepairHandler['apply']>[0], item: RepairItem): Promise<boolean> {
  const factId = item.cursor.id;
  const [fact] = await worldFactsFromPrivateSources(ctx.engine, [item.source_id], [factId]);
  if (!fact) return false;
  if (fact.row_num === null) {
    if (!await managedPersistenceEnabled(ctx.engine)) {
      return (await maintenanceTransaction(ctx.engine, tx => tightenDatabaseFacts(tx, item.source_id, [factId]))).length > 0;
    }
    const authority = (await maintenancePreflight(ctx.engine, item.source_id))!;
    const holder = await ctx.engine.readPageSnapshot(item.slug, { sourceId: item.source_id });
    const h = digest(['fact-visibility-v1', item.source_id, item.slug, factId, holder?.revision ?? null]);
    const receipt = await submitDatabaseMaintenanceIntent(ctx.engine, authority, item.slug,
      { kind: FACT_VISIBILITY_INTENT, expected_revision: holder?.revision ?? null, fact_ids: [factId] },
      `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`);
    return ((receipt.tightened as number[] | undefined) ?? []).includes(factId);
  }
  const snapshot = fact.source_markdown_slug ? await ctx.engine.readPageSnapshot(fact.source_markdown_slug, { sourceId: item.source_id }) : null;
  if (!snapshot || isSegmentedPage(snapshot.page)) return false;
  const body = strikeFenceRow(snapshot.page.compiled_truth ?? '', fact.row_num, row => ({ ...row, visibility: 'private' }));
  if (body === null) return false;
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug: snapshot.page.slug, source_id: item.source_id,
    content: serializePageToMarkdown({ ...snapshot.page, compiled_truth: body }, snapshot.tags), expected_revision: snapshot.revision,
    request_id: await repairRequestId(ctx, 'visibility', item, snapshot.revision) } });
  const [stored] = await ctx.engine.executeRaw<{ visibility: string }>('SELECT visibility FROM facts WHERE id=$1', [factId]);
  return stored?.visibility === 'private';
}

export const visibilityRepair: RepairHandler = {
  kind: 'visibility',
  async plan(engine: BrainEngine, scope: RepairScope, after: RepairCursor | null) {
    const { changes, chars, residuals } = await planVisibilityRepair(engine, scope.source_ids);
    const facts = await worldFactsFromPrivateSources(engine, scope.source_ids);
    const items: RepairItem[] = [...changes.map(change => ({ cursor: { phase: change.phase, id: change.id }, source_id: change.source_id,
      slug: change.slug, chars: chars.get(change.id) ?? 0, action: `visibility ${change.from ?? '(none)'} -> ${change.to}`,
      change: { from: change.from, to: change.to } })),
    ...facts.map(fact => ({ cursor: { phase: 4, id: Number(fact.id) }, source_id: fact.source_id,
      slug: fact.source_markdown_slug ?? fact.entity_slug ?? 'memory/unattributed', chars: 0,
      action: `fact ${fact.id} visibility world -> private${fact.readable ? ' (remotely readable now)' : ''}`, change: { from: 'world', to: 'private' } }))]
      .filter(item => afterCursor(item.cursor, after));
    return { items, residuals: { ...residuals, world_facts_remotely_readable: facts.filter(fact => fact.readable).length } };
  },
  async apply(ctx, item) {
    if (item.cursor.phase === 4) return applyFactItem(ctx, item);
    const snapshot = await ctx.engine.readPageSnapshot(item.slug, { sourceId: item.source_id });
    if (!snapshot || !item.change) return false;
    // Re-decide against current origins and inputs; a changed decision waits for the next run.
    const fresh = (await planVisibilityRepair(ctx.engine, [item.source_id], snapshot.page.id)).changes.find(c => c.id === snapshot.page.id);
    if (!fresh || fresh.from !== item.change.from || fresh.to !== item.change.to) return false;
    const page = { ...snapshot.page, frontmatter: { ...snapshot.page.frontmatter, visibility: item.change.to } };
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: item.slug, source_id: item.source_id,
      content: serializePageToMarkdown(page, snapshot.tags), expected_revision: snapshot.revision,
      request_id: await repairRequestId(ctx, 'visibility', item, snapshot.revision) } });
    return true;
  },
};
