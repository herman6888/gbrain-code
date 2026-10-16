/**
 * Logical subject keys and hashes of the belief ledger (docs/designs/BELIEF_LEDGER.md
 * section 3). A key never contains a row id: page-backed slug components are
 * serialized as the page lifetime (`L:<uuid>`), a slug that names no page as
 * `S:<source_incarnation>:<slug>`. Append, replay, subject lookup and state_hash
 * all use this one serialization.
 */
import { createHash } from 'node:crypto';

/** The fact fingerprint version the key carries (gbrain_fact_fingerprint, re-versioned once). */
export const FACT_FP_VERSION = 2;
export const COVERAGE_KEY = '["coverage"]';
/** The carrying fields a purge can redact, per subject kind (section 6.5). */
export const CARRYING_FIELDS: Readonly<Record<string, readonly string[]>> = { fact: ['context'], take: ['resolved_source'], link: ['context'] };
export const REDACTION_MARKER = (purgeRequest: string) => `[redacted: purge ${purgeRequest}]`;

export type SubjectRef = string;
export const lifetimeRef = (lifetime: string): SubjectRef => `L:${lifetime}`;
export const slugRef = (incarnation: string, slug: string): SubjectRef => `S:${incarnation}:${slug}`;

export const pageKey = (lifetime: string) => JSON.stringify(['p', lifetimeRef(lifetime)]);
export const factKey = (subject: SubjectRef, fingerprint: string, visibility: string) => JSON.stringify(['f', subject, FACT_FP_VERSION, fingerprint, visibility]);
export const ontologyKey = (entity: SubjectRef, dimension: string, valueHash: string, origin: SubjectRef | null, validFrom: string | null) =>
  JSON.stringify(['o', entity, dimension, valueHash, origin, validFrom]);
export const takeKey = (lifetime: string, claimHash: string, ordinal: number) => JSON.stringify(['t', lifetimeRef(lifetime), claimHash, ordinal]);
export const linkKey = (from: SubjectRef, to: SubjectRef, linkType: string, linkSource: string | null, origin: SubjectRef | null) =>
  JSON.stringify(['l', from, to, linkType, linkSource, origin]);
export const transitionKey = (link: string, kind: string, occurredOn: string, producer: string) => JSON.stringify(['lt', JSON.parse(link), kind, occurredOn, producer]);
/** A held write's key: scoped to its stream (lifetime, or slug when the page has none) so two holds with one fingerprint stay two keys. */
export const heldKey = (subject: SubjectRef, kind: string, fingerprint: string) => JSON.stringify(['h', subject, kind, fingerprint]);

/** Replace the subject component of a fact key (adoption moves `S:` to `L:`). */
export function factKeySubject(key: string): { subject: SubjectRef; rest: string } | null {
  const parsed = JSON.parse(key) as unknown[];
  if (parsed[0] !== 'f') return null;
  return { subject: String(parsed[1]), rest: JSON.stringify(parsed.slice(2)) };
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Canonical JSON: object keys sorted at every depth, so equal values hash equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export const valueHash = (value: unknown) => sha256Hex(canonicalJson(value));
export const takeClaimHash = (claim: string, kind: string, holder: string) => sha256Hex(canonicalJson([claim, kind, holder]));
export const fieldHash = (text: string) => sha256Hex(`field:${text}`);

/** event_key = sha256(publication_id ‖ subject_key ‖ event_type), hex for transport, BYTEA at rest. */
export const eventKeyHex = (publicationId: string, subjectKey: string, eventType: string) =>
  sha256Hex(`${publicationId}\u0000${subjectKey}\u0000${eventType}`);
