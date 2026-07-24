import { describe, expect, it } from 'vitest';
import { buildPlaceDeleteWarning, wordCount } from './placeDeleteWarning';

describe('wordCount', () => {
  it('counts whitespace-delimited words', () => {
    expect(wordCount('one two three')).toBe(3);
    expect(wordCount('  extra   spaces   here  ')).toBe(3);
  });

  it('treats undefined/empty/whitespace-only text as zero words', () => {
    expect(wordCount(undefined)).toBe(0);
    expect(wordCount('')).toBe(0);
    expect(wordCount('   ')).toBe(0);
  });
});

describe('buildPlaceDeleteWarning', () => {
  it('says plainly that a bare pin has nothing written on it', () => {
    expect(buildPlaceDeleteWarning({}, false)).toBe('This place has nothing written on it yet.');
  });

  it('names notes only, when only description is set', () => {
    expect(buildPlaceDeleteWarning({ description: 'Bring cash' }, false)).toBe(
      'This will also delete your notes.',
    );
  });

  it('names the review and its word count, when only selfReview is set', () => {
    expect(buildPlaceDeleteWarning({ selfReview: 'Loved every minute of it here' }, false)).toBe(
      'This will also delete your review (6 words).',
    );
  });

  it('joins review + notes with "and" when both are set', () => {
    expect(
      buildPlaceDeleteWarning({ description: 'Bring cash', selfReview: 'Great spot' }, false),
    ).toBe('This will also delete your review (2 words) and your notes.');
  });

  it('joins all three with an Oxford comma when a draft is also pending', () => {
    expect(
      buildPlaceDeleteWarning({ description: 'Bring cash', selfReview: 'Great spot' }, true),
    ).toBe('This will also delete your review (2 words), your notes, and an unsaved draft.');
  });

  it('mentions only the draft when there is nothing saved yet', () => {
    expect(buildPlaceDeleteWarning({}, true)).toBe('This will also delete an unsaved draft.');
  });

  it('treats whitespace-only description/selfReview as unset', () => {
    expect(buildPlaceDeleteWarning({ description: '   ', selfReview: '  ' }, false)).toBe(
      'This place has nothing written on it yet.',
    );
  });
});
