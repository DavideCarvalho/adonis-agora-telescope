import { describe, expect, it } from 'vitest';
import {
  formatCount,
  formatDuration,
  formatPercent,
  formatRelative,
  formatWindow,
  truncate,
} from './format.js';

describe('formatDuration', () => {
  it('renders sub-ms, ms, seconds and minutes', () => {
    expect(formatDuration(0.4)).toBe('400µs');
    expect(formatDuration(5.2)).toBe('5.2ms');
    expect(formatDuration(48)).toBe('48ms');
    expect(formatDuration(1240)).toBe('1.24s');
    expect(formatDuration(63000)).toBe('1m 3s');
  });
  it('renders a dash for null/undefined/NaN', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
  });
});

describe('formatCount', () => {
  it('adds thousands separators', () => {
    expect(formatCount(1234567)).toBe('1,234,567');
    expect(formatCount(0)).toBe('0');
    expect(formatCount(null)).toBe('—');
  });
});

describe('formatPercent', () => {
  it('scales a 0..1 ratio', () => {
    expect(formatPercent(0.0473)).toBe('4.7%');
    expect(formatPercent(1)).toBe('100.0%');
    expect(formatPercent(null)).toBe('—');
  });
});

describe('formatRelative', () => {
  const now = Date.parse('2026-07-13T12:00:00.000Z');
  it('buckets into just now / s / m / h / d', () => {
    expect(formatRelative('2026-07-13T11:59:58.000Z', now)).toBe('just now');
    expect(formatRelative('2026-07-13T11:59:30.000Z', now)).toBe('30s ago');
    expect(formatRelative('2026-07-13T11:45:00.000Z', now)).toBe('15m ago');
    expect(formatRelative('2026-07-13T09:00:00.000Z', now)).toBe('3h ago');
    expect(formatRelative('2026-07-09T12:00:00.000Z', now)).toBe('4d ago');
  });
  it('returns empty for bad input', () => {
    expect(formatRelative(null)).toBe('');
    expect(formatRelative('not-a-date')).toBe('');
  });
});

describe('formatWindow', () => {
  it('labels ms spans', () => {
    expect(formatWindow(300_000)).toBe('5m');
    expect(formatWindow(3_600_000)).toBe('1h');
    expect(formatWindow(86_400_000)).toBe('24h');
    expect(formatWindow(604_800_000)).toBe('7d');
  });
});

describe('truncate', () => {
  it('ellipsizes past the limit', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abc', 4)).toBe('abc');
  });
});
