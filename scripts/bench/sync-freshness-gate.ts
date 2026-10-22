#!/usr/bin/env bun
/**
 * GBRA-133 PR 2b.6: regression gate over the stable sync-freshness cells. Opt-in; never part of the PR tier.
 *
 *   bun scripts/bench/sync-freshness-gate.ts [--cells a,b] [--baseline scripts/bench/sync-freshness-baseline.json]
 *     [--work-dir DIR] [--out run.json] [--write-baseline FILE --machine-class NAME]
 *
 * Procedure per cell: one sync-freshness.ts run of 11 reps with a 50 ms probe; rep 0 is a discarded warm-up and the
 * gate value is the p50 of commit -> keyword-visible over reps 1..10. A cell fails when that p50 exceeds the committed
 * baseline p50 by more than 25%, or when any counted rep never became visible. A baseline is valid only on the machine
 * class it names (machine_class); --write-baseline records this run as the baseline instead of comparing.
 *
 * Only cells measured stable are gated: 25 runs on 5 fresh Ubicloud standard-4 VMs (the CI runner class) put every
 * serve-watch cell's p50 within a max/min ratio of 1.18, with no false failure in any of 600 baseline/candidate run
 * pairs at +25%. A manual managed sync was left out: its p50 moves with the VM (852 to 1254 ms, 52 of 600 pairs failed).
 */
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { machineInfo, pct } from './sync-freshness-lib.ts';

const REPO = resolve(import.meta.dir, '../..');
const argv = process.argv.slice(2);
const flag = (name: string, fallback: string) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback; };

const MARGIN = 1.25;
const REPS = 11;
const CELLS: Record<string, string[]> = {
  'postgres-managed-serve-watch': ['--engine', 'postgres', '--mode', 'managed', '--commit', 'single', '--trigger', 'serve', '--detection', 'watch'],
  'pglite-managed-serve-watch': ['--engine', 'pglite', '--mode', 'managed', '--commit', 'single', '--trigger', 'serve', '--detection', 'watch'],
  'postgres-classic-serve-watch': ['--engine', 'postgres', '--mode', 'classic', '--commit', 'single', '--trigger', 'serve', '--detection', 'watch'],
};
const names = flag('cells', Object.keys(CELLS).join(',')).split(',').filter(Boolean);
for (const n of names) if (!CELLS[n]) { console.error('unknown cell ' + n + '; known: ' + Object.keys(CELLS).join(', ')); process.exit(2); }
const WORK = resolve(flag('work-dir', join(REPO, '.context/bench/sync-freshness-gate')));
const BASELINE = resolve(flag('baseline', join(REPO, 'scripts/bench/sync-freshness-baseline.json')));
const WRITE = argv.includes('--write-baseline') ? resolve(flag('write-baseline', BASELINE)) : null;
mkdirSync(WORK, { recursive: true });

interface CellResult { cell: string; p50_ms: number | null; counted: Array<number | null>; warmup_ms: number | null; limit_ms?: number; baseline_ms?: number; pass?: boolean; reason?: string }
const results: CellResult[] = [];
for (const name of names) {
  const p = Bun.spawn([process.execPath, join(REPO, 'scripts/bench/sync-freshness.ts'), ...CELLS[name]!, '--pages', '10000', '--reps', String(REPS), '--probe-ms', '50',
    '--work-dir', WORK, '--label', 'gate', '--json'], { cwd: REPO, stdout: 'pipe', stderr: 'inherit' });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  const line = out.trim().split('\n').reverse().find(l => l.startsWith('{'));
  if (code !== 0 || !line) { results.push({ cell: name, p50_ms: null, counted: [], warmup_ms: null, pass: false, reason: 'bench exited ' + code }); continue; }
  const reps = (JSON.parse(line).reps as Array<{ search_ms: number | null }>).map(r => r.search_ms);
  const counted = reps.slice(1);
  const missing = counted.length < REPS - 1 || counted.some(x => x === null);
  results.push({ cell: name, p50_ms: missing ? null : pct(counted as number[], 50), counted, warmup_ms: reps[0] ?? null, ...(missing ? { pass: false, reason: 'a counted rep never became visible' } : {}) });
}

const run = { schema: 'gbrain-sync-freshness-gate/1', at: new Date().toISOString(), machine: machineInfo(), procedure: 'p50 of reps 1..10 of 11 (rep 0 discarded), 50 ms probe, 10k pages', cells: results };
const out = flag('out', '');
if (out) writeFileSync(resolve(out), JSON.stringify(run, null, 2) + '\n');
if (WRITE) {
  if (results.some(r => r.p50_ms === null)) { console.error('not writing a baseline: ' + results.filter(r => r.p50_ms === null).map(r => r.cell + ' (' + r.reason + ')').join(', ')); process.exit(1); }
  writeFileSync(WRITE, JSON.stringify({ schema: 'gbrain-sync-freshness-baseline/1', machine_class: flag('machine-class', 'unspecified'), measured_at: run.at, machine: run.machine,
    margin: MARGIN, cells: Object.fromEntries(results.map(r => [r.cell, { p50_ms: r.p50_ms }])) }, null, 2) + '\n');
  console.log('wrote baseline ' + WRITE);
} else {
  if (!existsSync(BASELINE)) { console.error('no baseline at ' + BASELINE); process.exit(2); }
  const base = JSON.parse(readFileSync(BASELINE, 'utf8')) as { machine_class: string; cells: Record<string, { p50_ms: number }> };
  for (const r of results) {
    const b = base.cells[r.cell];
    if (!b) { r.pass = false; r.reason = 'no baseline for this cell'; continue; }
    r.baseline_ms = b.p50_ms;
    r.limit_ms = Math.round(b.p50_ms * MARGIN * 10) / 10;
    if (r.pass === undefined) { r.pass = r.p50_ms! <= r.limit_ms; if (!r.pass) r.reason = 'p50 ' + r.p50_ms + ' ms > ' + r.limit_ms + ' ms (baseline ' + b.p50_ms + ' ms + 25%)'; }
  }
  console.log('Baseline machine class: ' + base.machine_class + '\n');
  console.log('| cell | p50 of 10 (ms) | baseline (ms) | limit (ms) | warm-up (ms) | verdict |');
  console.log('|---|---|---|---|---|---|');
  for (const r of results) console.log('| ' + [r.cell, r.p50_ms ?? '-', r.baseline_ms ?? '-', r.limit_ms ?? '-', r.warmup_ms ?? '-', r.pass ? 'pass' : 'FAIL: ' + r.reason].join(' | ') + ' |');
}
process.exit(results.every(r => r.pass !== false) ? 0 : 1);
