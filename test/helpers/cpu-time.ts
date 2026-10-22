/** The calling thread's CPU time, in milliseconds from an arbitrary origin. */
export function threadCpuNow(): number {
  const used = process.threadCpuUsage();
  return (used.user + used.system) / 1000;
}

/** A synchronous stretch of `ms` of thread CPU: work a loaded VM can delay but not lengthen or shorten. */
export function spinCpuMs(ms: number): void {
  const end = threadCpuNow() + ms;
  while (threadCpuNow() < end) { /* a stretch the loop cannot break */ }
}

/**
 * Event-loop lag as the thread's own work: the most CPU the calling thread ran between two runs of a `intervalMs`
 * timer (and after the last one, when `stop` is called). A bound on it measures how long code held the loop. Wall
 * time between ticks also counts what a loaded VM adds while the thread is off the CPU: run-queue waits, and sleeps
 * on a starved helper thread or on a spawned child that has not reached exec yet. On a 4-vCPU CI shard a 60 ms
 * stretch read 133 ms that way (#6712 PR 4b, test/sync-pass-shared-budget-6712.test.ts).
 */
export function watchLoopLag(intervalMs = 5): { stop(): { maxLag: number; ticks: number } } {
  let last = threadCpuNow(), maxLag = 0, ticks = 0;
  const timer = setInterval(() => { const now = threadCpuNow(); maxLag = Math.max(maxLag, now - last); last = now; ticks++; }, intervalMs);
  return { stop: () => { clearInterval(timer); return { maxLag: Math.max(maxLag, threadCpuNow() - last), ticks }; } };
}

/**
 * CPU time of a synchronous call on the calling thread, in milliseconds. A bound or scaling ratio over CPU time
 * measures the work rather than how long the scheduler made it wait, so load on a shared CI VM does not move it.
 * `process.threadCpuUsage` (as in test/entity-card-perf.slow.test.ts and src/core/progress.ts) leaves out the
 * engine's GC and JIT threads and any other concurrent work in the process. It does not see time spent waiting on
 * I/O, a subprocess, a timer or another thread: a test that bounds those keeps the wall clock.
 */
export function cpuMs(fn: () => unknown): number {
  const start = process.threadCpuUsage();
  fn();
  const used = process.threadCpuUsage(start);
  return (used.user + used.system) / 1000;
}

/**
 * cpuMs for an async span: thread CPU from the call until it settles. It counts everything the thread runs in
 * between (PGLite's WASM engine runs on the calling thread) and nothing the span waits for (I/O on other threads,
 * timers, subprocesses). Use it only where nothing else runs in the process during the span and the span does
 * not wait on I/O, a timer or another process.
 */
export async function cpuMsAsync(fn: () => Promise<unknown>): Promise<number> {
  const start = process.threadCpuUsage();
  await fn();
  const used = process.threadCpuUsage(start);
  return (used.user + used.system) / 1000;
}
