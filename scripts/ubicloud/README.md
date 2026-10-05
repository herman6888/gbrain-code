# Ubicloud fan-out (`ci:ubicloud`)

`scripts/ci-ubicloud.ts` runs the `ci:local` gate on ephemeral Ubicloud VMs
instead of one Docker host. It packs the working tree once (tracked files,
untracked files that are not ignored, and `.git`) and streams it to every VM, so
uncommitted edits are tested. `scripts/ubicloud/ubi-runner.sh` creates and
destroys the VMs; every VM is destroyed on exit, including Ctrl-C, and any
`ubirun-*` VM older than 12 hours is garbage-collected by the next run.

Each VM runs `scripts/ubicloud/setup-ci-vm.sh`: the pinned Bun from
`docker-compose.ci.yml`, the runner container's test prerequisites plus Node,
frozen dependencies, both PGLite snapshot fixtures, and one
`pgvector/pgvector:pg16` server fronted by a transaction-mode PgBouncer per
slot. Every slot's schema is bootstrapped with `setupLegacyEmbeddingDB()`, the
same step nightly full-corpus E2E workers run, so no E2E file depends on which
file reaches a database first. Setup takes 70-90 seconds, including VM boot.

Scheduling is dynamic. Every unit, serial, slow and E2E file is one item in a
global queue ordered by weight, heaviest first. Each idle slot on any VM takes
the next item, so a slow VM or a mis-weighted file delays only the slot holding
it. Light items leave in same-lane batches to amortize SSH round trips, and the
batch target shrinks as the queue drains. Items of 60 seconds or more are the
run's long poles, so they spread one per VM before any VM takes a second one.
The first VM to finish setup runs the
machine-level work first: gitleaks, `verify`, then the serial lane's
machine-exclusive files one at a time with nothing else on that VM. After that
it joins the pool. Items run through the `ci:local` wrappers
(`scripts/ubicloud/ci-item.sh`): `run-unit-shard.sh`, `run-serial-tests.sh` and
`run-slow-tests.sh` accept explicit file arguments for this purpose, and
`run-e2e.sh` runs each E2E file against its slot's own server and pooler. The
unit, serial and slow lanes run with database URLs unset. Tests run natively as
a non-root user on Ubuntu 24.04, the same OS as the CI runners, instead of as
root in the `oven/bun` container.

Weights come from, in order: `.context/ci-ubicloud/weights.json` (merged after
every run), the committed `scripts/ubicloud/weights.json` (refresh it with
`--record-weights` on a green full run), then the lane weight files mined from
GitHub CI. Unknown files get their lane's p75. Per-item logs, failure logs and
`summary.json` land in `.context/ci-ubicloud/<run>/`. The exit status is non-zero
when any item fails, an item never produces a result, or no VM becomes ready.
An item whose SSH batch dies without a result is retried once on any slot, and a
VM with three such infrastructure errors is retired.

Defaults are four `standard-16` VMs (64 vCPUs) in `eu-central-h1` with 8 slots
each, one per two vCPUs (`--vms`, `--size`, `--slots`, `--location`). The
Ubicloud project's vCPU quota (256) is shared with pull-request CI, so the
default leaves room for about two concurrent PR runs; the former default of
ten VMs took 160 vCPUs and queued PR jobs for up to 28 minutes. A VM that the
quota refuses fails to provision and the run continues on the VMs that did
start, so a busy project shrinks the fleet instead of failing. Pass `--vms 10`
only when the quota is idle. Slow-lane items run `test/export-scale.slow.test.ts`
at the pull-request scale (`GBRAIN_TEST_EXPORT_SCALE_PAGES=10001`). `--lanes` runs a
subset, `--keep` leaves the VMs up for debugging, and `--diff` follows
`ci:local:diff` (a doc-only diff runs the doc checks and gitleaks alone). The corpus is roughly
8,000 seconds of test compute at that density, so 80 slots finish everything
but the longest files about two minutes after setup; more slots per VM add CPU
contention that slows timing-sensitive files without shortening the run. Wall time is bounded
by setup plus the longest single file,
`test/reindex-markdown-persistence.slow.test.ts` (one test, about 230 seconds),
so adding VMs past the default does not shorten a run.
