import { describe, expect, it } from 'vitest';
import {
  CONFLICT_SENTINEL,
  CONFLICT_SEPARATOR,
  appendRemoteIfDifferent,
  hasMergedEdit,
  splitMergedProse,
} from './proseMerge';

describe('appendRemoteIfDifferent', () => {
  it('keeps local unchanged when remote is empty', () => {
    expect(appendRemoteIfDifferent('mine', undefined)).toBe('mine');
    expect(appendRemoteIfDifferent('mine', '   ')).toBe('mine');
  });

  it('keeps local unchanged when the two sides say the same thing', () => {
    expect(appendRemoteIfDifferent('same text', '  same text  ')).toBe('same text');
  });

  it('returns remote as-is when there is no local text (no leading separator)', () => {
    expect(appendRemoteIfDifferent(undefined, 'theirs')).toBe('theirs');
    expect(appendRemoteIfDifferent('', 'theirs')).toBe('theirs');
  });

  it('appends both sides with the sentinel between them, discarding neither', () => {
    const merged = appendRemoteIfDifferent('mine', 'theirs');
    expect(merged).toContain('mine');
    expect(merged).toContain('theirs');
    expect(merged).toBe(`mine${CONFLICT_SEPARATOR}theirs`);
  });

  it('accumulates across repeated conflicts without losing earlier text', () => {
    const once = appendRemoteIfDifferent('a', 'b');
    const twice = appendRemoteIfDifferent(once, 'c');
    expect(splitMergedProse(twice)).toEqual(['a', 'b', 'c']);
  });
});

describe('splitMergedProse', () => {
  it('yields a single segment for ordinary un-merged prose', () => {
    expect(splitMergedProse('just my notes')).toEqual(['just my notes']);
  });

  it('yields nothing for empty prose', () => {
    expect(splitMergedProse(undefined)).toEqual([]);
    expect(splitMergedProse('')).toEqual([]);
  });

  // The actual regression guard: the writer and the reader must agree on the
  // sentinel byte-for-byte. If either side's string drifts, this round trip
  // stops splitting and the raw sentinel would surface in the user's prose.
  it('round-trips text written by appendRemoteIfDifferent', () => {
    const merged = appendRemoteIfDifferent('my write-up', 'their write-up');
    expect(splitMergedProse(merged)).toEqual(['my write-up', 'their write-up']);
    expect(merged).not.toBe(splitMergedProse(merged).join(''));
  });

  it('leaves no fragment of the sentinel inside any rendered segment', () => {
    const merged = appendRemoteIfDifferent('mine', 'theirs')!;
    for (const segment of splitMergedProse(merged)) {
      expect(segment).not.toContain('Also written');
      expect(segment).not.toContain('—');
    }
  });
});

describe('hasMergedEdit', () => {
  it('detects merged text and ignores ordinary text', () => {
    expect(hasMergedEdit(appendRemoteIfDifferent('a', 'b'))).toBe(true);
    expect(hasMergedEdit('plain notes')).toBe(false);
    expect(hasMergedEdit(undefined)).toBe(false);
  });
});

describe('the sentinel itself', () => {
  // Pinned deliberately. `mockup/place-detail-modal.html` (the approved visual
  // spec) hardcodes this exact string, and the stored prose of every already-
  // merged place embeds it. Changing it orphans existing merge boundaries —
  // they would render as raw text with no divider. If this test fails, that is
  // the question to answer, not a string to update reflexively.
  it('matches the approved design, em dashes and all', () => {
    expect(CONFLICT_SENTINEL).toBe('— Also written on another device —');
  });

  it('stands alone as its own paragraph in raw text', () => {
    expect(CONFLICT_SEPARATOR).toBe(`\n\n${CONFLICT_SENTINEL}\n\n`);
  });
});
