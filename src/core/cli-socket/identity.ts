/**
 * The brain identity the warm CLI socket is bound to. A serve computes it once
 * when it binds; the CLI computes it per call and sends it in the request. The
 * serve answers only an identical token, so a CLI aimed at another database,
 * another GBRAIN_HOME, another brain (mount), an edited config file, a
 * different behavior-relevant environment or another gbrain release always
 * takes its own cold path. The socket path alone never decides.
 */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import type { GBrainConfig } from '../config.ts';
import { listRecipes } from '../ai/recipes/index.ts';

/**
 * GBRAIN_* variables left out of the digest: the socket switch and diagnostics
 * never change an answer, and GBRAIN_SOURCE travels in every request
 * (`routing.source_env`) and is resolved per request, as the cold CLI does.
 */
const NON_BEHAVIOR_GBRAIN_ENV = new Set(['GBRAIN_CLI_SOCKET', 'GBRAIN_DEBUG', 'GBRAIN_SQL_TRACE', 'GBRAIN_SOURCE']);
/** Provider credentials: only whether each is set enters the digest. Every other provider variable (endpoints, deployments, versions, org/project/group ids) enters with its value. */
const SECRET_PROVIDER_ENV = /(_API_KEY|_TOKEN|_SECRET)$/;
/** Provider env names read outside the recipe registry: the Google alias and the compatibility endpoints. */
const EXTRA_PROVIDER_ENV = ['GEMINI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL'];

let providerEnvNames: string[] | undefined;
function providerEnv(): string[] {
  providerEnvNames ??= [...new Set([
    ...listRecipes().flatMap(recipe => [...(recipe.auth_env?.required ?? []), ...(recipe.auth_env?.optional ?? [])]),
    ...EXTRA_PROVIDER_ENV,
  ])].sort();
  return providerEnvNames;
}

/**
 * SHA-256 over the environment that changes what a read answers or where its
 * text goes: every GBRAIN_* name and value except NON_BEHAVIOR_GBRAIN_ENV, the
 * names (never the values) of the provider credentials that are set, and the
 * names and values of every other provider variable that is set (base URLs,
 * endpoints, deployments, API versions, org/project/group ids).
 */
export function behaviorEnvDigest(env: Record<string, string | undefined>): string {
  const gbrain = Object.keys(env)
    .filter(key => key.startsWith('GBRAIN_') && !NON_BEHAVIOR_GBRAIN_ENV.has(key) && env[key] !== undefined)
    .sort()
    .map(key => [key, env[key]]);
  const set = providerEnv().filter(name => env[name] !== undefined && env[name] !== '');
  const credentials = set.filter(name => SECRET_PROVIDER_ENV.test(name));
  const routing = set.filter(name => !SECRET_PROVIDER_ENV.test(name)).map(name => [name, env[name]]);
  return createHash('sha256').update(JSON.stringify({ gbrain, credentials, routing })).digest('hex');
}

/** Database URL without its password, with the host, port and query parameters in one canonical spelling. */
export function canonicalDatabaseTarget(databaseUrl: string): string {
  let url: URL;
  try { url = new URL(databaseUrl); }
  catch { return `unparsed:${createHash('sha256').update(databaseUrl).digest('hex')}`; }
  const params = [...url.searchParams.entries()]
    .filter(([key]) => !/pass/i.test(key))
    .sort(([a, av], [b, bv]) => a === b ? av.localeCompare(bv) : a.localeCompare(b));
  const protocol = url.protocol === 'postgres:' ? 'postgresql:' : url.protocol;
  const user = decodeURIComponent(url.username);
  return `${protocol}//${user ? `${user}@` : ''}${url.hostname.toLowerCase()}:${url.port || '5432'}`
    + `${decodeURIComponent(url.pathname) || '/'}${params.length ? `?${new URLSearchParams(params).toString()}` : ''}`;
}

function realpathOr(path: string): string {
  try { return realpathSync(path); } catch { return `absent:${path}`; }
}

function fileDigest(path: string): string {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return 'absent'; }
}

export interface CliSocketIdentityInput {
  /** The serve's: the config its engine connected with. The CLI's: the config it would connect with. */
  config: Pick<GBrainConfig, 'engine' | 'database_url'>;
  /** The resolved brain id (src/core/brain-resolver.ts resolveBrainId). */
  brainId: string;
  configDir: string;
  configFile: string;
  version: string;
  env: Record<string, string | undefined>;
}

/** SHA-256 over the brain id, the canonical database target, the config home and file (realpath and content), the behavior env and the gbrain version. */
export function cliSocketIdentity(input: CliSocketIdentityInput): string {
  const fields = {
    v: 2,
    version: input.version,
    brain: input.brainId,
    env: behaviorEnvDigest(input.env),
    engine: input.config.engine,
    database: input.config.database_url ? canonicalDatabaseTarget(input.config.database_url) : null,
    config_dir: realpathOr(input.configDir),
    config_file: realpathOr(input.configFile),
    config_sha256: fileDigest(input.configFile),
  };
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}
