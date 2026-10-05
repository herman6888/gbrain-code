import type { BrainEngine } from '../engine.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import type { ImportResult, ParsedPage } from '../import-file.ts';

/** Parsing/provider work is complete. apply must run under the coordinator's transaction. */
export interface PreparedContentImport {
  slug: string;
  parsedPage: ParsedPage;
  observedRevision: string | null;
  noop: boolean;
  /** The imported content hash, when apply writes the page (`coordinated` callers verify their read-back against it). */
  contentHash?: string;
  result: ImportResult;
  validate(tx: BrainEngine): Promise<void>;
  /** `preimage` (#5984): the publisher's guarded read of this page at the observed revision (see PreparedMutation.apply). */
  apply(tx: BrainEngine, preimage?: PageSnapshot | null): Promise<void>;
}
