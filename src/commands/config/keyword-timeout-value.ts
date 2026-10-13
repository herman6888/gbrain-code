/**
 * `config set` value check for `search.keyword_statement_timeout_ms` (#6495):
 * nothing is written when the value is outside the range the Postgres engine
 * would accept, because a stored value outside it reads as the default.
 */
import { exitCliError, usageError } from '../../cli/cli-error.ts';
import {
  KEYWORD_STATEMENT_TIMEOUT_DEFAULT_MS,
  KEYWORD_STATEMENT_TIMEOUT_KEY,
  KEYWORD_STATEMENT_TIMEOUT_MAX_MS,
  keywordStatementTimeoutValueProblem,
} from '../../core/postgres-engine/keyword-statement-timeout.ts';

export function refuseInvalidKeywordTimeoutValue(key: string, value: string): void {
  if (key !== KEYWORD_STATEMENT_TIMEOUT_KEY) return;
  const problem = keywordStatementTimeoutValueProblem(value);
  if (!problem) return;
  exitCliError(usageError(problem, `Re-run with an integer number of milliseconds, e.g. gbrain config set ${KEYWORD_STATEMENT_TIMEOUT_KEY} ${KEYWORD_STATEMENT_TIMEOUT_DEFAULT_MS} (the cap is ${KEYWORD_STATEMENT_TIMEOUT_MAX_MS}).`, {
    why: 'The Postgres engine reads the keyword statement timeout once per connection and treats a value outside 1000..60000 as the default, so writing it would change nothing.',
    fix: { argv: ['gbrain', 'config', 'get', key], consent: [], actor: 'agent', why: 'Shows the value in effect; nothing was written.', requires_exclusive: false },
  }), 'config');
}
