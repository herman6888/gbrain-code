/**
 * derived_visibility doctor check (#5525): extracted atoms and synthesized
 * concepts without an explicit `visibility`, and ones stored looser than their
 * origin (a transcript or missing origin counts as private, as in the repair).
 * Remote reads treat unstamped rows as private; the warning names the
 * tighten-only backfill `gbrain repair visibility` that stamps the stored rows.
 *
 * It also counts what is labelled wider than a private source: Life Chronicle
 * events whose origin is private, pages that carry a privacy alias
 * (`access: private`, ...) but no `visibility`, and active `world` facts held
 * in or extracted from a private page. Facts a remote caller can recall today
 * are listed by id (first 50); slugs stay out of the check, which remote
 * callers may run. `gbrain repair visibility` previews every row.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { derivationPrivateSql, privateSnapshotFilterFragment } from '../../../core/search/private-visibility.ts';
import { aliasOnlyPagesSql, worldFactsFromPrivateSources } from '../../../core/repair/visibility.ts';

const FACT_SAMPLE = 50;

export async function derivedVisibilityCheck(engine: BrainEngine, sourceId?: string): Promise<Check> {
  const name = 'derived_visibility';
  try {
    const [row] = await engine.executeRaw<{ unstamped_atoms: number; unstamped_concepts: number; looser_atoms: number; looser_concepts: number; looser_events: number; alias_pages_without_visibility: number }>(
      `WITH derived AS (
         SELECT p.* FROM pages p WHERE p.deleted_at IS NULL ${sourceId ? 'AND p.source_id=$1' : ''}
           AND (p.type='atom' OR (p.type='concept' AND p.frontmatter->>'synthesized_by' IS NOT NULL)
             OR (p.type='event' AND p.frontmatter->>'captured_via' LIKE 'life-chronicle:%')))
       SELECT
         COUNT(*) FILTER (WHERE d.type='atom' AND d.frontmatter->>'visibility' IS NULL)::int AS unstamped_atoms,
         COUNT(*) FILTER (WHERE d.type='concept' AND d.frontmatter->>'visibility' IS NULL)::int AS unstamped_concepts,
         COUNT(*) FILTER (WHERE d.type='atom' AND d.frontmatter->>'visibility'='world' AND NOT EXISTS (SELECT 1 FROM pages o
           WHERE o.source_id=d.source_id AND o.slug=d.frontmatter->>'source_slug' AND o.deleted_at IS NULL
             AND ${privateSnapshotFilterFragment('o')}))::int AS looser_atoms,
         COUNT(*) FILTER (WHERE d.type='concept' AND d.frontmatter->>'visibility'='world' AND EXISTS (SELECT 1 FROM links l
           JOIN pages a ON a.id=l.to_page_id WHERE l.from_page_id=d.id AND l.link_source='concept-provenance' AND l.link_type='synthesized_from'
             AND (COALESCE(a.frontmatter->>'visibility','private')='private' OR EXISTS (SELECT 1 FROM pages ao WHERE ao.source_id=a.source_id
               AND ao.slug=a.frontmatter->>'source_slug' AND ao.frontmatter->>'visibility'='private'))))::int AS looser_concepts,
         COUNT(*) FILTER (WHERE d.type='event' AND COALESCE(d.frontmatter->>'visibility','world')<>'private' AND EXISTS (SELECT 1 FROM pages o
           WHERE o.source_id=d.source_id AND o.slug=d.frontmatter->'event'->>'depth' AND o.deleted_at IS NULL
             AND ${derivationPrivateSql('o')}))::int AS looser_events,
         (SELECT COUNT(*)::int FROM pages ap WHERE ${aliasOnlyPagesSql('ap')} ${sourceId ? 'AND ap.source_id=$1' : ''}) AS alias_pages_without_visibility
       FROM derived d`, sourceId ? [sourceId] : []);
    const sources = sourceId ? [sourceId] : (await engine.executeRaw<{ id: string }>('SELECT id FROM sources')).map(s => s.id);
    const facts = await worldFactsFromPrivateSources(engine, sources);
    const readable = facts.filter(f => f.readable);
    const details = { ...row, world_facts_from_private_sources: facts.length, world_facts_remotely_readable: readable.length,
      remotely_readable_fact_ids: readable.slice(0, FACT_SAMPLE).map(f => String(f.id)), fact_ids_truncated: readable.length > FACT_SAMPLE,
      count: 'exact', truncated: false, repair: 'visibility' };
    const unstamped = row.unstamped_atoms + row.unstamped_concepts;
    const looser = row.looser_atoms + row.looser_concepts + row.looser_events;
    if (unstamped + looser + row.alias_pages_without_visibility + facts.length === 0) {
      return { name, status: 'ok', details, message: 'Every derived page and fact carries a visibility no looser than its source, and no page relies on a privacy alias alone.' };
    }
    const parts: string[] = [];
    if (unstamped + looser) parts.push(`${unstamped} derived page(s) have no explicit visibility (${row.unstamped_atoms} atoms, ${row.unstamped_concepts} concepts) `
      + `and ${looser} are stored looser than their origin (${row.looser_events} chronicle events); remote reads treat the unstamped ones as private.`);
    if (row.alias_pages_without_visibility) parts.push(`${row.alias_pages_without_visibility} page(s) mark themselves private with a privacy alias (access, confidentiality) but carry no visibility, so remote page reads treat them as world.`);
    if (facts.length) parts.push(`${facts.length} active world fact(s) are held in or were extracted from a private page; ${readable.length} of them are readable by remote callers (ids in details.remotely_readable_fact_ids).`);
    parts.push('Preview: gbrain repair visibility — apply after the user agrees: gbrain repair visibility --apply');
    return { name, status: 'warn', details, message: parts.join(' ') };
  } catch (e) {
    return { name, status: 'warn', message: `derived visibility check skipped: ${e instanceof Error ? e.message : String(e)}`,
      details: { count: 'lower_bound', truncated: true, health: 'unknown' } };
  }
}
