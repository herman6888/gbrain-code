import { describe, expect, test } from 'bun:test';
import {
  planExtractionChunks,
  MAX_EXTRACTION_CHUNKS,
  DEFAULT_EXTRACT_CHUNK_OVERLAP_CHARS,
} from '../src/core/cycle/extract-atoms.ts';

describe('planExtractionChunks (#6503)', () => {
  test('fits-the-cap: single window, byte-for-byte the truncation path', () => {
    const text = 'a'.repeat(1000);
    const chunks = planExtractionChunks(text, 5000, 500);
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.start).toBe(0);
    expect(chunks[0]!.text).toBe(text);
  });

  test('empty text: single empty window', () => {
    const chunks = planExtractionChunks('', 5000, 500);
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.text).toBe('');
  });

  test('oversized: windows cover the whole text with overlap', () => {
    const text = 'x'.repeat(1000);
    const chunks = planExtractionChunks(text, 400, 100);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    // Every window within cap.
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(400);
    // Full coverage: first window starts at 0, last window ends at text end.
    expect(chunks[0]!.start).toBe(0);
    const last = chunks[chunks.length - 1]!;
    expect(last.start + last.text.length).toBe(text.length);
    // Contiguity/overlap: no gap between consecutive windows.
    for (let i = 1; i < chunks.length; i++) {
      const prevEnd = chunks[i - 1]!.start + chunks[i - 1]!.text.length;
      expect(chunks[i]!.start).toBeLessThanOrEqual(prevEnd);
    }
    // Middle windows carry the overlap (strictly before prev end).
    for (let i = 1; i < chunks.length - 1; i++) {
      const prevEnd = chunks[i - 1]!.start + chunks[i - 1]!.text.length;
      expect(chunks[i]!.start).toBe(prevEnd - 100);
    }
  });

  test('boundary-spanning quote is whole in at least one window', () => {
    // A 40-char phrase straddling the first cap boundary.
    const prefix = 'a'.repeat(380);
    const phrase = 'THE_IMPORTANT_PHRASE_SPANNING_BOUNDARY';
    const suffix = 'b'.repeat(200);
    const text = prefix + phrase + suffix;
    const chunks = planExtractionChunks(text, 400, 100);
    const hit = chunks.filter(c => c.text.includes(phrase));
    expect(hit.length).toBeGreaterThanOrEqual(1);
  });

  test('the last window keeps its overlap so boundary-spanning quotes survive', () => {
    const text = 'x'.repeat(850);
    const chunks = planExtractionChunks(text, 400, 100);
    const last = chunks[chunks.length - 1]!;
    const prev = chunks[chunks.length - 2]!;
    // Overlap retained: repeats are deduped downstream by atom title.
    expect(last.start).toBeLessThanOrEqual(prev.start + prev.text.length);
  });

  test('surrogate pairs are never split', () => {
    const text = `🚀${'x'.repeat(398)}🚀${'y'.repeat(398)}🚀`;
    const chunks = planExtractionChunks(text, 400, 50);
    for (const c of chunks) {
      // Every surrogate in the window has its pair inside the same window.
      for (let i = 0; i < c.text.length; i++) {
        const u = c.text.charCodeAt(i);
        if (u >= 0xd800 && u <= 0xdbff) {
          const lo = c.text.charCodeAt(i + 1);
          expect(lo >= 0xdc00 && lo <= 0xdfff).toBe(true);
          i++;
        } else if (u >= 0xdc00 && u <= 0xdfff) {
          throw new Error('window starts a low surrogate — pair was split');
        }
      }
    }
  });

  test('pathological length is capped at MAX_EXTRACTION_CHUNKS windows', () => {
    const text = 'z'.repeat(5000);
    const chunks = planExtractionChunks(text, 100, 20);
    expect(chunks.length).toBe(MAX_EXTRACTION_CHUNKS);
  });

  test('deterministic: same input, same windows', () => {
    const text = 'abc中文字符'.repeat(200);
    const a = planExtractionChunks(text, 150, DEFAULT_EXTRACT_CHUNK_OVERLAP_CHARS);
    const b = planExtractionChunks(text, 150, DEFAULT_EXTRACT_CHUNK_OVERLAP_CHARS);
    expect(a).toEqual(b);
  });

  test('overlap >= cap still makes progress (no infinite loop)', () => {
    const text = 'q'.repeat(1000);
    const chunks = planExtractionChunks(text, 100, 500);
    expect(chunks.length).toBeLessThanOrEqual(MAX_EXTRACTION_CHUNKS);
    const last = chunks[chunks.length - 1]!;
    expect(last.start + last.text.length).toBe(text.length);
  });
});
