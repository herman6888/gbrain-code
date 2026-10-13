/**
 * Guard: `query` expands only when the search mode says so (GBRA-81 item 1b),
 * so no source file or doc may claim it expands "in every mode" or "always".
 * Scans src/, docs/ and the root agent docs; CHANGELOG history is exempt.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const ROOT_DOCS = ['INSTALL_FOR_AGENTS.md', 'CLAUDE.md', 'AGENTS.md', 'README.md'];

/** An expansion word and "in every mode" in one clause, or "always expands". */
const CLAIM = /\b(?:expands?|expansion|expanding)\b[^.;\n]{0,40}\bin every mode\b|\bin every mode\b[^.;\n]{0,20}\bexpan(?:ds?|sion)\b|\balways (?:expands?|requests expansion)\b/i;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|md)$/.test(name) ? [path] : [];
  });
}

describe('query expansion phrasing guard', () => {
  test('the pattern catches the retired claims and spares unrelated "every mode" text', () => {
    for (const old of [
      '`query` expands in every mode unless explicitly disabled',
      'gbrain query requests expansion in every mode unless you pass --no-expand.',
      '(the only verb that can expand) expands by default in every mode',
      'the `query` op always expands',
    ]) expect(old).toMatch(CLAIM);
    for (const fine of ['autocut is off in every mode since rule R2', 'floor 1 in every mode', '`query` expands only when the mode says so']) {
      expect(fine).not.toMatch(CLAIM);
    }
  });

  test('no file in src/, docs/ or the root agent docs says query expands in every mode', () => {
    const offenders: string[] = [];
    const paths = [...files(join(ROOT, 'src')), ...files(join(ROOT, 'docs')), ...ROOT_DOCS.map(f => join(ROOT, f))];
    for (const path of paths) {
      readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
        if (CLAIM.test(line)) offenders.push(`${relative(ROOT, path)}:${i + 1}: ${line.trim().slice(0, 160)}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
