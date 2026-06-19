import { describe, expect, it } from 'vitest';
import { NewExceptionTracker } from '../src/index.js';

const WINDOW = 60_000;

describe('NewExceptionTracker', () => {
  it('reports the first occurrence of a family as new', () => {
    const tracker = new NewExceptionTracker();
    expect(tracker.observe('fam-A', 1_000, WINDOW)).toBe(true);
  });

  it('does NOT report a repeat within the window as new', () => {
    const tracker = new NewExceptionTracker();
    tracker.observe('fam-A', 1_000, WINDOW);
    expect(tracker.observe('fam-A', 1_000 + WINDOW - 1, WINDOW)).toBe(false);
  });

  it('reports as new again once the window has elapsed (re-occurrence)', () => {
    const tracker = new NewExceptionTracker();
    tracker.observe('fam-A', 1_000, WINDOW);
    expect(tracker.observe('fam-A', 1_000 + WINDOW, WINDOW)).toBe(true);
  });

  it('reports as new again immediately after an explicit resolve', () => {
    const tracker = new NewExceptionTracker();
    tracker.observe('fam-A', 1_000, WINDOW);
    expect(tracker.observe('fam-A', 1_500, WINDOW)).toBe(false);
    tracker.resolve('fam-A');
    expect(tracker.observe('fam-A', 1_600, WINDOW)).toBe(true);
  });

  it('caps the map and evicts the oldest inserted family', () => {
    const tracker = new NewExceptionTracker(2);
    tracker.observe('fam-A', 1, WINDOW);
    tracker.observe('fam-B', 2, WINDOW);
    tracker.observe('fam-C', 3, WINDOW); // evicts fam-A
    expect(tracker.size).toBe(2);
    expect(tracker.observe('fam-A', 4, WINDOW)).toBe(true);
  });
});
