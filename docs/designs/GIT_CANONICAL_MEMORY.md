# Git as the source of truth for agent-written memory

Status: design. Every switch named here ships off, and nothing changes on upgrade.
Supersedes: [DATABASE_CANONICAL_MEMORY.md](DATABASE_CANONICAL_MEMORY.md) (database as the source of truth, files as a one-way export), which is kept for its incident analysis.
Citation convention: repo-relative paths on master 5a4c5805 (v0.60.433.0).

## Decision

Git stays the parent. For a source in strict git-canonical mode (`canonical: git`, chosen per source, default off), every page-content write goes through one door: the file is written, it is committed under the checkout's writer lock, and only then does the database commit the row. The database is an index of what git holds. It never holds page content that git does not have, except for declared database-only classes (below) and derived data. When git and the database disagree, git wins and the database re-derives from the committed blob.

This keeps the property small brains already rely on (rebuild the index from files, read and edit memory as Markdown, review it with git) and removes the cause of most large-brain incidents: two copies of record with many uncoordinated writers. The database-canonical design reached the same diagnosis and picked the other parent; this design picks git because the files are the product's identity and the database is the part that can always be rebuilt.

## Today

Almost every content write is database-first today. In managed mode `publishMutation` (`src/core/persistence/coordinator.ts:450`) runs prepare, a durable recovery record, the file rename, then the database row and receipt in one transaction, and only then queues a Git effect that commits later and pushes. In classic mode the row lands first and write-through renders the file from it. Several writers (unmanaged `importFromContent` callers, direct coordinated database writes, the withdrawal ledger, some fact paths) write rows with no file at all. So between the database commit and the Git commit the database is ahead of git, and when anything interferes (a crash, a parked push, a person editing the file, a foreign merge) sync has to decide which copy is right. That decision is the hold vocabulary: `file_drift`, `concurrent_write`, held deletions, `source_changed` refusals.

## The model

```mermaid
flowchart LR
  W[put_page, capture, remember, facts, takes, dream, connectors] --> PM[publishMutation]
  R[remote or thin-client writes] -->|journal request| PM
  PM -->|1 write the file| F[(checkout)]
  F -->|2 path-only commit under the writer lock| G[(git commit)]
  G -->|3 row and receipt, stamped with the commit| D[(database)]
  G -->|4 push-only effect, batched| O[(remote)]
  P[people and other clones] --> G
  G -->|indexer: committed blobs only, git wins| D
```

1. **One door.** `publishMutation` stays the single write path. For a strict source it commits the written paths locally (the path-only commit `gbrain git commit-push` already performs) between the file rename and the database transaction, and stamps the commit on the receipt. The Git effect becomes push-only. Writes that arrive while a commit is in flight join the next commit (group commit), so commit cost is paid per group, not per write.
2. **Recovery follows git.** A crash after the commit and before the database transaction is finished by indexing the committed file, not by restoring the previous bytes.
3. **The indexer reads commits, not the worktree.** For a strict source the managed sync pass reads the level at HEAD alone and imports each committed blob the database does not hold, keyed by path and blob id so replays are idempotent: a database version sync never saw, a drifted page and a page under an uncommitted edit all take the committed bytes, and the edit stays on disk. A committed removal deletes the page. An uncommitted absence means nothing. There is no hold classification, because there is nothing to classify: git is right by definition. The pass refuses `--working-tree`, the level it keeps between passes is dropped when `canonical` flips, and a pass that runs between a door commit and its database transaction leaves that write's replay to finish it (the door's own bytes are already committed, so the replay publishes them once). `gbrain sources reindex <id> --from-git` previews every database version Git replaces, bound to HEAD by a hash, and `--apply --expect <hash>` runs that pass; doctor `git_index_lag` reports how many commits and seconds a strict source's index trails HEAD.

   The one place the working tree reaches Git on a strict source is the door commit itself. `commitThroughDoor` stages each written path as it stands in the working tree (a path-only commit under the writer lock), so an uncommitted edit made to that path after the write's rename and before its commit is committed by the write that owns the path. That is deliberate: the writer lock holds the path, and the commit is the write's own. Nothing else, sync included, reads the working tree of a strict source.
4. **Push is off the write path.** Pushes are batched, integrate a moved remote in memory, and skip changes that are patch-equivalent to commits this checkout already made. A genuine two-sided conflict on a page path parks only the push; local commits and writes continue, and doctor reports it.
5. **Enforced in the database.** For a strict source, a page-content change that does not come from the door or the indexer is refused, so an older binary cannot write database-first.

## Declared database-only classes

Some content deliberately has no file. In strict mode each such class is declared, and anything undeclared is refused with a typed code that names the git home to configure.

| Class | Handling |
|---|---|
| Private, alias-private and lineage-private pages | Never committed. Making a page private is a door commit that removes its file, and the row stays database-only; making it public writes the file through the door. Content pushed before it became private stays in git history. |
| `storage.db_only` prefixes and the derive-phase folders (`DERIVE_PHASE_DB_ONLY_DEFAULTS`, `src/core/storage-config.ts:425`) | The door refuses to commit under them and the indexer ignores them. |
| Paths the checkout's Git ignores (for example archived images) | Never committed and never given a Git effect, so they cannot park. |
| Database-only sources (no checkout, `sync.write_through=false`, unbound) | Outside strict mode; the whole source is the class. |
| Derived data (chunks, embeddings, mention links, rows parsed from fences and timelines, receipts) | Rebuilt from git or kept as metadata; never content of record. |

The database backup covers the declared classes; git covers everything else.

## What has to gain a file form

Some authored content lives only in database rows today. Each gets a Markdown home before its writer can go through the door: fact withdrawals become fence edits and the withdrawal ledger is derived on import; facts with no fence move into fences; manual links, owner actions and extraction-authored timeline rows get a Markdown form. Forgetting removes a fact from current files and from the index; earlier commits keep it, and gbrain never promises physical erasure.

## What this retires, for a strict source

| Class | Why it cannot occur |
|---|---|
| `file_drift`, `concurrent_write`, `source_changed` drift refusals | The database is never ahead of git, and when git moves the index follows. |
| Held deletions, `file_gone`, never-committed files | Only a committed removal deletes; worktree absence is not read. |
| Per-write Git effects that park | Commits happen in the door; pushes are batched and never block writes. |
| Database-first writers overwriting a file (the compare-before-replace class) | No writer writes a row whose file is not already committed. |
| Ignored-path parking | Ignored paths are a declared class and never get a Git effect. |

What remains: a bad merge from another clone is indexed as committed (git wins), so a merge that reintroduces older blobs changes the index too; doctor flags a foreign commit that sets a path back to a blob the door had replaced, and the fix is a git revert. Write latency includes a local commit; group commit and plumbing commits keep that bounded on large checkouts, and the soak sets the window.

## Remote and hosted writes

A write from a remote MCP caller or a thin client becomes a journal request that the checkout owner's door commits. The caller receives the revision once it is committed and indexed, or `write_pending` with a request id while the owner is unavailable. It is never written database-first. A hosted brain runs the door against a server-side bare repository, with an optional push to a repository the user owns.

## Conversion

A source changes mode only through a preview-bound verb. The preview is the [git-gap census](#the-git-gap-census): every page whose row differs from its committed blob, every page with no file that is not in a declared class, held items and parked effects, by category. The operator chooses per category to commit the database content through the door, declare it, or let git win. The preview lists any database content that git-wins would discard, and the apply binds to that preview. A source can return to its previous mode.

## The git-gap census

`gbrain sources git-gap <source-id> [--sample n] [--json]` is the read-only preview conversion will bind to, and doctor `db_ahead_of_git` reports its totals per source with a Git checkout (informational in G1: always ok). It compares every live page with the blob committed at HEAD, read with hardened plumbing (`ls-tree`, `cat-file --batch`, `check-ignore`), so no repository filter, textconv or hook runs. It never reads `git status` or `git diff`. Each page lands in exactly one state:

| State | Meaning | What conversion does with it |
|---|---|---|
| `equal` | The row equals the HEAD blob under the export equality contract (fact withdrawals overlaid; a segmented page byte for byte). | Nothing; the indexer would derive the same row. |
| `database_ahead` | A blob exists at HEAD and the row differs; the sample lists the differing field paths. | The operator commits the database content through the door or lets git win; the preview lists what git-wins would discard. |
| `git_ahead` | The HEAD blob is not the blob the page last imported, per its sync import record (`blob_oid` / `disk_blob_oid`), so git moved since the import. `git_ahead_database_also_moved` counts pages whose row moved too. | Git wins: the indexer imports the committed blob. Where both moved, the preview lists the database edit git-wins would discard. |
| `declared_database_only` | A declared class (counted per class): `mirror_source`, `private`, `alias_private`, `lineage_private`, `database_only` (`database_only_reason`), `db_only_prefix` (`storage.db_only`), `derive_folder` (a never-filed page under the derive-phase defaults), `git_ignored`. `declared_with_head_blob` counts those whose file is still committed, such as a page that turned private. | They stay out of git. A still-committed file of a private page is removed by a door commit; earlier commits keep it. |
| `undeclared_database_only` | No blob at HEAD and no declared reason. | Commit it through the door, declare its class, or delete it. Strict mode refuses it until then. |
| `worktree_only` | A file exists in the working tree but not at HEAD. | Commit it through the door or remove it; a strict indexer reads only commits. |
| `unparseable` | The committed blob is not UTF-8 Markdown the importer accepts, or is a symlink. | A person fixes the file; conversion refuses the page until then. |
| `unsafe_path` | The recorded `source_path` maps to no safe file path. | Reconcile the path first. |

Without an import record (classic sync, or a page imported before records were written) the census cannot tell which side moved, so a page whose file changed in git counts as `database_ahead`; `database_ahead_without_import_record` says how many. The working tree is reported separately by raw bytes against HEAD (`clean`, `modified`, `deleted`, `untracked`, `absent`); a checkout whose attributes convert line endings reads as modified. In strict mode an uncommitted change means nothing.

The census also counts rows with no Git home, which G4 and G5 give a file form: active facts with no fence row, fenced facts whose fence page is missing or has no committed file, links whose `link_source` is not one a file derives (`markdown`, `frontmatter`, `mentions`, `wikilink-resolved`; `manual`, custom tags, `concept-provenance`, `atom-provenance` and legacy NULL rows all count), and timeline rows on pages with no committed file. Open sync holds are counted by code and parked effect targets by kind and code; strict mode retires both in G8.

## Waves

| Wave | Ships |
|---|---|
| G1 | this document; the read-only git-gap census (`gbrain sources git-gap`) and doctor `db_ahead_of_git` |
| G2 | the door: path-only commit before the database transaction, inverted recovery, group commit, push-only effect, per-source strict flag |
| G3 | the indexer: committed blobs only, unconditional import, re-derive verb with preview, index-lag check |
| G4 | memory and facts get a file form (withdrawals as fence edits, unfenced facts into fences) |
| G5 | authored rows written by direct coordinated database writes get a file form |
| G6 | unmanaged writers routed through the door with batched commits |
| G7 | declared classes, large files, remote and hosted writes |
| G8 | conversion verb, retirement of the hold machinery for strict sources |

Every wave is default-off and changes nothing for existing sources until a source is converted.
