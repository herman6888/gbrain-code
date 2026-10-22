/**
 * Per-search connection budget (GBRA-156). One search or query op starts its
 * independent reads together to save round trips; this caps how many pooled
 * connections those reads hold at once, so a burst of searches shares the
 * read pool instead of each one taking it whole.
 *
 * The engine's two connection seams (PostgresEngine#transactionOn for a
 * top-level transaction, runUnsafe for a statement) wait for a slot inside a
 * budget scope and hold it until the statement or the transaction's COMMIT
 * settles. Work inside a held slot runs outside the scope, so statements on
 * the transaction's own connection never wait on a second slot. Outside a
 * scope, and on PGLite, nothing changes.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** The most pooled connections one search or query op holds at once. */
export const SEARCH_CONNECTION_LIMIT = 4;

interface Budget { free: number; waiters: Array<() => void> }
const budgets = new AsyncLocalStorage<Budget | null>();

/** Run `fn` under one budget; a nested call shares the enclosing one. */
export function withSearchConnectionBudget<T>(fn: () => Promise<T>): Promise<T> {
  if (budgets.getStore()) return fn();
  return budgets.run({ free: SEARCH_CONNECTION_LIMIT, waiters: [] }, fn);
}

/** Hold one slot of the current budget while `fn` runs; without a budget, run it directly. */
export async function holdSearchConnection<T>(fn: () => Promise<T>): Promise<T> {
  const budget = budgets.getStore();
  if (!budget) return fn();
  if (budget.free > 0) budget.free -= 1;
  else await new Promise<void>(resolve => budget.waiters.push(resolve));
  try {
    return await budgets.run(null, fn);
  } finally {
    const next = budget.waiters.shift();
    if (next) next(); else budget.free += 1;
  }
}
