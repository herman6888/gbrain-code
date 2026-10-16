import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { loadConfig, loadConfigWithEngine } from '../config.ts';
import { loadOperatorLiterals } from '../content-sanity-literals.ts';
import { parseMarkdown } from '../markdown.ts';
import { parseDataFrontmatter } from '../data-frontmatter.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { recordedPathFromFileUri, scannerSlugRootMode, scannerSourcePath } from '../write-through.ts';
import { findLiveFileClaimants, recordedReconcilePath, type FileClaimTarget } from './file-claims.ts';
import { sharedOriginExit } from './sync-origin.ts';
export { fileClaimCandidatesQuery } from './file-claims.ts';
import { localHostId } from './identity.ts';
import { isDatabaseOnlyPage, slugDerivedOrigin } from './unbound-pages.ts';
import { isUnboundSourcePage } from './unbound-source.ts';
import { getWorktreeBinding, type WorktreeBinding } from './ownership.ts';
import { digest, requireUuid, sha256, stableJson } from './digest.ts';
import { reconcileCanonical, strictReconcileKeys, validateReconcileJson, type ReconcileConflict, type ReconcileDecision } from './reconcile-merge.ts';
import type { ParsedPage } from '../import-file.ts';
import type { AutoDecision } from './reconcile-additive.ts';
import { publishesDatabaseOnly, readCanonicalAsImported } from './page-prepare.ts';
import { isMirrorOnlyPage } from './mirror-read-only.ts';

export interface ReconcilePins {
  brain_id: string; source_id: string; source_incarnation: string; slug: string; page_id: number;
  worktree_id: string; binding_digest: string; owner_epoch: string; revision: string;
  raw_file_hash: string; relative_path: string; policy_digest: string; withdrawals_digest: string; assessment_at: string;
}
export interface ReconcileArtifact {
  /** 2 when the preview carries #5974 automatic decisions. */
  format_version: 1 | 2; preview_id: string; preconditions: ReconcilePins;
  preimages: { file_base64: string; database: PageSnapshot; stored_page: Record<string, unknown> };
  decisions: ReconcileDecision[]; conflicts: ReconcileConflict[]; result: ParsedPage; result_digest: string;
  status: 'needs_resolution' | 'ready';
  auto_decisions?: AutoDecision[];
}
export interface ReconcileState {
  binding: WorktreeBinding; root: string; path: string; raw: Buffer; snapshot: PageSnapshot;
  /** The path the importer reads the file under (`scannerSourcePath`), for path inference (#6605). */
  importPath: string;
  storedPage: Record<string, unknown>; file: ParsedPage; pins: ReconcilePins;
  /** `slug_derived`: a database-only page matched to the canonical file at its slug path. */
  origin: 'recorded' | 'slug_derived';
  /** The `source_path` apply records for a `slug_derived` origin. */
  originSourcePath: string | null;
}
/**
 * Cycle bookkeeping that `cycle.ts` stamps into `sources.config` after every
 * successful source cycle. It is not reconcile policy, so it stays out of the
 * policy digest: otherwise an autopilot cycle between preview and apply made
 * every reconcile preview stale.
 */
const CYCLE_STAMP_KEYS = ['last_source_cycle_at', 'last_full_cycle_at'];

export async function reconcilePolicyDigest(engine: BrainEngine, sourceId: string): Promise<string> {
  const config = await loadConfigWithEngine(engine, loadConfig());
  const [row] = await engine.executeRaw<Record<string, unknown>>('SELECT config,contextual_retrieval_mode,trust_frontmatter_overrides FROM sources WHERE id=$1', [sourceId]);
  let sourceConfig = row?.config;
  if (typeof sourceConfig === 'string') {
    try { sourceConfig = JSON.parse(sourceConfig); } catch { /* digest the raw text */ }
  }
  if (sourceConfig && typeof sourceConfig === 'object' && !Array.isArray(sourceConfig)) {
    sourceConfig = Object.fromEntries(Object.entries(sourceConfig).filter(([key]) => !CYCLE_STAMP_KEYS.includes(key)));
  }
  const source = row ? { ...row, config: sourceConfig } : row;
  return digest({ version: 1, config, source, literals: loadOperatorLiterals(), disabled: process.env.GBRAIN_NO_SANITY ?? null });
}
export function staleReconcile(what: string): never {
  throw new OperationError('source_changed', `Reconciliation preview is stale: ${what}.`, 'Generate a fresh preview; submit a corrected intent with a new request ID.');
}
/**
 * Refuses when another live page of the source records the reconciled file as its own
 * (`findLiveFileClaimants`, file-claims.ts: the paged same-name census, realpath deciding).
 * #6517: the refusal names the exit, a soft delete of the page that should not own the file.
 */
async function assertSoleFileClaim(engine: BrainEngine, target: FileClaimTarget): Promise<void> {
  const [claimant] = await findLiveFileClaimants(engine, target);
  if (claimant) throw opError('source_changed', 'Several pages claim the recorded canonical file.',
    `Nothing changed. Pages ${target.slug} and ${claimant.slug} in '${target.sourceId}' both record the same file, so reconcile cannot tell which owns it; decide with the user which page owns the file before reconciling either. `
    + sharedOriginExit(target.sourceId, [target.slug, claimant.slug]) + ' Then preview again.');
}
/**
 * #6394: `adoptSlugPath` lets a live page with no recorded origin and no database-only marker reconcile against the file
 * at its slug path (mode-aware, as discovery names it). A page that publishes database-only by design (a declared db_only
 * slug, a never-filed derive-phase page) or a mirror-only page never adopts one.
 */
export async function readReconcileState(engine: BrainEngine, sourceId: string, slug: string, assessmentAt = new Date().toISOString(),
  opts: { adoptSlugPath?: boolean } = {}): Promise<ReconcileState> {
  const binding = await getWorktreeBinding(engine, sourceId);
  if (!binding?.local_path || binding.owner_host_id !== localHostId() || binding.state !== 'active') {
    throw new OperationError('owner_unavailable', 'Reconciliation requires the existing active owner on this host.', 'Run repair on the current owner; repair never claims or activates a source.');
  }
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  const snapshot = await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
  if (!snapshot || snapshot.page.deleted_at) throw opError('page_not_found', 'Reconciliation requires an existing live page; use the separate restore workflow for deleted pages.',
    `Page ${slug} in '${sourceId}' is deleted or missing; nothing changed. If it was deleted by mistake, restore it (gbrain restore, within the 72-hour window) and then preview it again.`,
    { fix: readFix('Shows whether the page exists or is soft-deleted in this source.', { argv: ['gbrain', 'get', '--source', sourceId, '--include-deleted', '--', slug] }) });
  if (binding.source_incarnation !== snapshot.sourceIncarnation) staleReconcile('source binding incarnation');
  const [storedPage] = await engine.executeRaw<Record<string, unknown>>(`SELECT id,source_id,slug,type,title,compiled_truth,timeline,frontmatter,
    content_hash,source_path,source_kind,source_uri,ingested_via,ingested_at,knowledge_revision,deleted_at FROM pages WHERE id=$1 AND source_id=$2`, [snapshot.page.id, sourceId]);
  const root = realpathSync(join(binding.local_path, binding.relative_path));
  const recorded = recordedPathFromFileUri(snapshot.page.source_uri, root);
  const mode = await scannerSlugRootMode(engine, sourceId, root);
  const recordedPath = recordedReconcilePath(root, snapshot.page, mode);
  const marked = !recordedPath && isDatabaseOnlyPage({ ...snapshot.page,
    database_only_reason: await isUnboundSourcePage(engine, sourceId, slug) ? 'unbound_source' : null });
  const adoptable = !recordedPath && !marked && opts.adoptSlugPath === true && !snapshot.page.source_uri
    && !publishesDatabaseOnly(root, slug, snapshot) && !await isMirrorOnlyPage(engine, sourceId, slug);
  const derived = marked || adoptable ? slugDerivedOrigin(root, slug, mode) : null;
  const origin = derived ? 'slug_derived' : 'recorded';
  const path = recordedPath ?? derived?.path ?? null;
  if (!path || !isWriteTargetContained(path, root)) throw opError('source_changed', 'The page has no unambiguous confined recorded Markdown origin.',
    `Page ${slug} in '${sourceId}' records no Markdown file inside the source checkout, so there is nothing to reconcile it against; nothing changed. ${!recordedPath && !marked && !snapshot.page.source_uri && opts.adoptSlugPath !== true
      ? `If the file at its slug path is this page's canonical file, preview again with --adopt-slug-path (gbrain sources reconcile ${sourceId} ${slug} --preview --adopt-slug-path) to adopt it; otherwise check its recorded source path with the command in fix.` : 'Check its recorded source path with the command in fix.'}`,
    { fix: readFix('Shows the page and its recorded source path.', { argv: ['gbrain', 'get', '--source', sourceId, '--', slug] }) });
  let size: number;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('not an ordinary file');
    size = info.size;
  } catch {
    throw opError('source_changed', 'The recorded canonical file is missing or is not an ordinary file; repair does not restore files.',
      `Nothing changed. Restore the canonical file of ${slug} in '${sourceId}' as a regular file (for example from git), then preview the page again.`);
  }
  const { readJournalLimits } = await import('./limits.ts');
  const limits = await readJournalLimits(engine);
  if (size > Math.min(limits.principalIntentBytes, limits.brainIntentBytes, limits.worktreeRecoveryBytes)) {
    throw opError('request_too_large', 'The canonical file exceeds reconciliation capacity.',
      `Nothing changed. The canonical file of ${slug} in '${sourceId}' is larger than the journal's request and recovery limits; tell the user the page needs a manual edit of that file.`);
  }
  const canonicalPath = realpathSync(path);
  await assertSoleFileClaim(engine, { sourceId, slug, pageId: snapshot.page.id, root, mode, path, canonicalPath,
    recordedUri: recorded ? snapshot.page.source_uri ?? null : null });
  const raw = readFileSync(path), text = raw.toString('utf8');
  if (!Buffer.from(text).equals(raw)) throw opError('invalid_params', 'The canonical file must contain valid UTF-8.',
    `Nothing changed. Re-save the canonical file of ${slug} in '${sourceId}' as UTF-8, then preview the page again.`);
  try { parseDataFrontmatter(text); }
  catch {
    throw opError('invalid_params', 'Canonical file metadata cannot be parsed losslessly; repair its syntax before previewing.',
      `Nothing changed. Fix the frontmatter of the canonical file of ${slug} in '${sourceId}' (quote values containing ': ', close the --- block), then preview the page again.`);
  }
  // Preserve a terminal .md in the page key while parsing the canonical Markdown.
  const importPath = scannerSourcePath(root, path, mode);
  const reading = reconcileFileReading(text, importPath, snapshot.page);
  const parsed = parseMarkdown(reading.content, `${slug}.md`, { validate: true, expectedSlug: slug });
  if (reading.inferred) parsed.type = snapshot.page.type;
  const errors = parsed.errors?.filter(e => !['MISSING_OPEN', 'MISSING_CLOSE', 'EMPTY_FRONTMATTER'].includes(e.code)) ?? [];
  if (!errors.length && !parsed.errors?.some(e => e.code === 'MISSING_CLOSE') && parsed.slug !== slug) {
    // #5966 (W14 P1.7): a well-formed file whose path derives another slug is a legacy render of a slug the
    // path cannot derive, written before renders stamped `slug:`; the frontmatter repair proposes the stamp.
    throw opError('source_changed', 'The canonical file carries no slug stamp, so its path derives a different slug.',
      `Nothing changed. The file of ${slug} in '${sourceId}' reads as ${parsed.slug} from its path. Preview the stamp with gbrain repair frontmatter --source ${sourceId} --only ${relative(root, path)} (a safe repair), apply it, then preview the page again.`,
      { detail: 'slug_rule_mismatch' });
  }
  if (errors.length || parsed.errors?.some(e => e.code === 'MISSING_CLOSE') || parsed.slug !== slug) {
    throw opError('invalid_params', 'Canonical file metadata cannot be parsed losslessly; repair its syntax before previewing.',
      `Nothing changed. Fix the frontmatter of the canonical file of ${slug} in '${sourceId}' (close the --- block, keep its slug), then preview the page again.`);
  }
  const pins: ReconcilePins = { brain_id: brain.brain_id, source_id: sourceId, source_incarnation: snapshot.sourceIncarnation, slug,
    page_id: snapshot.page.id, worktree_id: binding.worktree_id, binding_digest: digest({ binding, root, path: canonicalPath }), owner_epoch: String(binding.owner_epoch),
    revision: snapshot.revision, raw_file_hash: sha256(raw), relative_path: relative(root, path),
    policy_digest: await reconcilePolicyDigest(engine, sourceId), withdrawals_digest: digest({ withdrawals: snapshot.withdrawals, global_purges: snapshot.globalPurges ?? null }), assessment_at: assessmentAt };
  return { binding, root, path, importPath, raw, snapshot, storedPage, file: reconcileCanonical(parsed, parsed.tags), pins, origin, originSourcePath: derived?.sourcePath ?? null };
}
/** #6394: a preview made with --adopt-slug-path recorded a page with no origin; apply and publication adopt the same pinned file. */
export function reconcilePreviewAdopts(artifact: Pick<ReconcileArtifact, 'preimages'>): boolean {
  const stored = (artifact.preimages as { stored_page?: { source_path?: unknown; source_uri?: unknown } | null } | null)?.stored_page;
  return stored != null && stored.source_path == null && stored.source_uri == null;
}
export function assertReconcilePins(expected: ReconcilePins, actual: ReconcilePins): void {
  for (const key of Object.keys(expected) as Array<keyof ReconcilePins>) if (expected[key] !== actual[key]) staleReconcile(key);
}
export function validateReconcileArtifact(value: unknown): ReconcileArtifact {
  validateReconcileJson(value);
  const v2 = (value as Record<string, unknown> | null)?.format_version === 2;
  strictReconcileKeys(value, ['format_version', 'preview_id', 'preconditions', 'preimages', 'decisions', 'conflicts', 'result', 'result_digest', 'status',
    ...(v2 ? ['auto_decisions'] : [])], ['format_version', 'preview_id', 'preconditions', 'preimages', 'decisions', 'conflicts', 'result', 'result_digest', 'status',
    ...(v2 ? ['auto_decisions'] : [])]);
  if (v2) {
    if (!Array.isArray(value.auto_decisions) || !value.auto_decisions.length || value.auto_decisions.length > 1000) throw opError('invalid_params', 'Malformed automatic reconciliation decisions.',
      'Re-run the same reconcile preview with --auto-additive to recreate the file instead of editing it by hand.');
    for (const entry of value.auto_decisions as unknown[]) {
      strictReconcileKeys(entry, ['path', 'rule', 'rule_version', 'evidence_digest']);
      if (typeof entry.path !== 'string' || typeof entry.rule !== 'string' || !Number.isSafeInteger(entry.rule_version)
        || typeof entry.evidence_digest !== 'string' || !/^[a-f0-9]{64}$/.test(entry.evidence_digest)) {
        throw opError('invalid_params', 'Malformed automatic reconciliation decisions.',
      'Re-run the same reconcile preview with --auto-additive to recreate the file instead of editing it by hand.');
      }
    }
  }
  strictReconcileKeys(value.preconditions, ['brain_id', 'source_id', 'source_incarnation', 'slug', 'page_id', 'worktree_id', 'binding_digest',
    'owner_epoch', 'revision', 'raw_file_hash', 'relative_path', 'policy_digest', 'withdrawals_digest', 'assessment_at']);
  strictReconcileKeys(value.preimages, ['file_base64', 'database', 'stored_page']);
  // globalPurges is optional here so an artifact written before the '*' purge marker validates and then reads stale (assertPreimages).
  strictReconcileKeys(value.preimages.database, ['page', 'tags', 'revision', 'sourceIncarnation', 'withdrawals', 'globalPurges'],
    ['page', 'tags', 'revision', 'sourceIncarnation', 'withdrawals']);
  if (value.preimages.database.globalPurges !== undefined) strictReconcileKeys(value.preimages.database.globalPurges, ['count', 'latest', 'world_only']);
  strictReconcileKeys(value.preimages.database.page, ['id', 'slug', 'source_id', 'type', 'title', 'compiled_truth', 'timeline', 'frontmatter',
    'content_hash', 'source_path', 'knowledge_revision', 'text_projection_revision', 'emotional_weight', 'created_at', 'updated_at', 'updated_at_iso',
    'deleted_at', 'effective_date', 'effective_date_source', 'import_filename', 'salience_touched_at', 'source_kind', 'source_uri', 'ingested_via',
    'ingested_at', 'contextual_retrieval_mode', 'corpus_generation'], ['id', 'slug', 'source_id', 'type', 'title', 'compiled_truth', 'timeline', 'frontmatter']);
  strictReconcileKeys(value.preimages.stored_page, ['id', 'source_id', 'slug', 'type', 'title', 'compiled_truth', 'timeline', 'frontmatter',
    'content_hash', 'source_path', 'source_kind', 'source_uri', 'ingested_via', 'ingested_at', 'knowledge_revision', 'deleted_at']);
  strictReconcileKeys(value.result, ['type', 'title', 'compiled_truth', 'timeline', 'frontmatter', 'tags']);
  const result = value.result;
  if (value.format_version !== 1 && !v2 || typeof value.preview_id !== 'string' || !['ready', 'needs_resolution'].includes(String(value.status)) ||
    !Array.isArray(value.conflicts) || !Array.isArray(value.decisions) || !Array.isArray(value.preimages.database.tags) ||
    !Array.isArray(value.preimages.database.withdrawals) || !Array.isArray(value.result.tags) || value.result.tags.some(v => typeof v !== 'string') ||
    ['type', 'title', 'compiled_truth', 'timeline'].some(key => typeof result[key] !== 'string') ||
    value.result.frontmatter === null || typeof value.result.frontmatter !== 'object' || Array.isArray(value.result.frontmatter) ||
    typeof value.preimages.file_base64 !== 'string' ||
    digest(value.result) !== value.result_digest || typeof value.preconditions.assessment_at !== 'string' ||
    !Number.isFinite(Date.parse(value.preconditions.assessment_at)) || !Number.isSafeInteger(value.preconditions.page_id) ||
    Object.entries(value.preconditions).some(([key, v]) => key !== 'page_id' && typeof v !== 'string')) {
    throw opError('invalid_params', 'Malformed or modified reconciliation artifact.',
      'Pass the preview file exactly as reconcile wrote it with --out; change it only through --decisions. If it was edited, make a fresh preview.');
  }
  for (const key of ['brain_id', 'source_incarnation', 'worktree_id', 'revision']) requireUuid(value.preconditions[key] as string);
  requireUuid(value.preview_id as string);
  for (const key of ['binding_digest', 'raw_file_hash', 'policy_digest', 'withdrawals_digest']) {
    if (!/^[a-f0-9]{64}$/.test(value.preconditions[key] as string)) {
      throw opError('invalid_params', 'Invalid reconciliation fingerprint.',
        'Pass the preview file exactly as reconcile wrote it with --out; if it was edited, make a fresh preview.');
    }
  }
  for (const conflict of value.conflicts as unknown[]) strictReconcileKeys(conflict, ['path', 'file', 'database']);
  for (const withdrawal of value.preimages.database.withdrawals as unknown[]) strictReconcileKeys(withdrawal, ['visibility', 'fact_hash', 'withdrawn_at', 'purged'], ['visibility', 'fact_hash', 'withdrawn_at']);
  return JSON.parse(stableJson(value)) as ReconcileArtifact;
}

/**
 * #6605: the file side of a reconciliation, read the way the importer stored it. A frontmatter-less file under a
 * directory-inference rule was imported with the frontmatter its path infers, so its raw bytes would show every
 * inferred key as a difference. The inferred reading is used when the stored row carries every key it adds (an
 * inferring import wrote the row); a row imported without inference (`gbrain reindex` on an unmanaged brain) is
 * compared with the raw bytes. An inferred `type:` is not one the file declared: the caller keeps the stored type.
 */
export function reconcileFileReading(text: string, sourcePath: string, stored: { frontmatter?: Record<string, unknown> | null }): { content: string; inferred: boolean } {
  const reading = readCanonicalAsImported(text, sourcePath);
  if (!reading.inferred) return reading;
  const keys = Object.keys(parseMarkdown(reading.content, sourcePath).frontmatter);
  return keys.every(key => Object.hasOwn(stored.frontmatter ?? {}, key)) ? reading : { content: text, inferred: false };
}
