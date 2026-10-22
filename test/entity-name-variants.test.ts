/**
 * #7160: name-variant matching for entity lookup (pure). Synthetic names only.
 */
import { describe, expect, test } from 'bun:test';
import { editDistance, hasLeadingTitle, matchNameVariant, parsePersonName, probeWords } from '../src/core/entities/name-variants.ts';

describe('matchNameVariant', () => {
  const cases: Array<[string, string, string | null]> = [
    ['Alice Example', 'Alice Example', 'normalized'],
    ['alice-example', 'Alice Example', 'normalized'],
    ['Dr. Alice Example', 'Alice Example', 'honorific'],
    ['Mayor Alice Example Jr.', 'Alice Example', 'honorific'],
    ['example alice', 'Alice Example', 'reordered'],
    ['Example, Alice', 'Alice Example', 'reordered'],
    ['Allie Example', 'Alice Example', 'diminutive'],
    ['Bob Thistlewood', 'Robert Thistlewood', 'diminutive'],
    ['Robert Thistlewood', 'Bob Thistlewood', 'diminutive'],
    ['A. Example', 'Alice Example', 'initial'],
    ['A Example', 'Alice Example', 'initial'],
    ['Alice Exmaple', 'Alice Example', 'typo'],
    ['Alicee Example', 'Alice Example', null],
    ['Jon Example', 'Joe Example', null],
    ['Allie Exmaple', 'Alice Example', 'typo'],
    ['Example', 'Alice Example', 'surname'],
    ['Mayor Example', 'Alice Example', 'surname'],
    ['Alicia Example', 'Alice Example', null],
    ['Alice Examples', 'Alice Example', 'typo'],
    ['Bob Example', 'Alice Example', null],
    ['B. Example', 'Alice Example', null],
    ['Ex', 'Alice Example', null],
    ['Alice', 'Alice Example', null],
    ['Alice Example', 'Example', null],
    ['Alice Q Example', 'Alice Example', null],
  ];
  for (const [q, c, kind] of cases) {
    test(`${q} vs ${c} -> ${kind}`, () => expect(matchNameVariant(q, c)).toBe(kind as never));
  }
});

describe('helpers', () => {
  test('parsePersonName strips leading titles and trailing suffixes, keeps a title-only name', () => {
    expect(parsePersonName('Senator Dr. Alice Example III')).toEqual({ core: ['alice', 'example'], titles: ['senator', 'dr'] });
    expect(parsePersonName('Mayor')).toEqual({ core: ['mayor'], titles: [] });
  });
  test('hasLeadingTitle reads titles and slug basenames', () => {
    expect(hasLeadingTitle('Mayor Example')).toBe(true);
    expect(hasLeadingTitle('mayor-example')).toBe(true);
    expect(hasLeadingTitle('Alice Example')).toBe(false);
  });
  test('editDistance counts a transposition as one edit and caps', () => {
    expect(editDistance('example', 'exmaple')).toBe(1);
    expect(editDistance('example', 'exampel')).toBe(1);
    expect(editDistance('example', 'sample')).toBe(2);
  });
  test('probeWords keeps core words of three or more letters', () => {
    expect(probeWords('Dr. A. Example')).toEqual(['example']);
  });
});
