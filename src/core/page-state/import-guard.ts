import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';
import type { ParsedPage } from '../import-file.ts';
import { OperationError } from '../ops/contract.ts';
import { stableJson } from '../persistence/digest.ts';
import { assertPageRevision, type PageSnapshot } from './types.ts';

/** Imported bytes are prepared outside transactions; publication still needs CAS. */
export async function assertImportBase(tx: BrainEngine, slug: string, sourceId: string, existing: Page | null): Promise<void> {
  await tx.lockPageKeys([{ sourceId, slug }]);
  const current = await tx.getPage(slug, { sourceId, includeDeleted: true });
  if ((current?.id ?? null) !== (existing?.id ?? null)) {
    throw new OperationError('page_identity_changed', 'The imported page was deleted or recreated during preparation.');
  }
  assertPageRevision(current ? { revision: current.knowledge_revision! } : null, existing ? { expectedRevision: existing.knowledge_revision } : {});
}
const canonicalFields = (p: Page | ParsedPage) => ({ type: p.type, title: p.title, compiled_truth: p.compiled_truth,
  timeline: p.timeline ?? '', frontmatter: p.frontmatter });

/** Content hashes omit volatile metadata; a prepared no-op must compare all canonical fields. */
export function sameCanonicalImport(existing: PageSnapshot | null, parsed: ParsedPage): boolean {
  if (!existing) return false;
  const tags = [...new Set([...existing.tags, ...parsed.tags])].sort();
  return stableJson(canonicalFields(existing.page)) === stableJson(canonicalFields(parsed)) && stableJson([...existing.tags].sort()) === stableJson(tags);
}

/**
 * #5158: the stored content_hash digests frontmatter in insertion order, so a
 * file whose keys were only reordered hashes differently. This key-sorted
 * comparison of every canonical field and the exact tag set recognizes it as
 * unchanged without touching the stored hash formula.
 */
export async function sameContentAnyKeyOrder(engine: Pick<BrainEngine, 'getTags'>, existing: Page, existingTags: string[] | null,
  parsed: ParsedPage, sourceId: string): Promise<boolean> {
  if (existing.deleted_at || existing.type !== parsed.type || existing.title !== parsed.title
    || existing.compiled_truth !== parsed.compiled_truth || (existing.timeline ?? '') !== (parsed.timeline ?? '')) return false;
  if (stableJson(canonicalFields(existing)) !== stableJson(canonicalFields(parsed))) return false;
  const tags = existingTags ?? await engine.getTags(existing.slug, { sourceId });
  return stableJson([...tags].sort()) === stableJson([...parsed.tags].sort());
}
