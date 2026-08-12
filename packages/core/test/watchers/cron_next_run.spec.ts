import { afterEach, describe, expect, it } from 'vitest';
import { __resetCronParserCacheForTests, nextCronRunMs } from '../../src/watchers/cron_next_run.js';

afterEach(() => {
  __resetCronParserCacheForTests();
});

describe('nextCronRunMs', () => {
  it('computes the next fire time strictly after `fromMs` (cron-parser is a devDependency here)', () => {
    // '0 * * * *' fires on the hour. From 12:30:00 the next fire is 13:00:00.
    const from = Date.UTC(2024, 0, 1, 12, 30, 0);
    const next = nextCronRunMs('0 * * * *', from);
    expect(next).not.toBeNull();
    expect(new Date(next as number).toISOString()).toBe('2024-01-01T13:00:00.000Z');
  });

  it('returns the immediately-next fire when `fromMs` lands exactly on one (never itself)', () => {
    const from = Date.UTC(2024, 0, 1, 13, 0, 0);
    const next = nextCronRunMs('0 * * * *', from);
    expect(new Date(next as number).toISOString()).toBe('2024-01-01T14:00:00.000Z');
  });

  it('returns null for an invalid expression rather than throwing', () => {
    expect(nextCronRunMs('not a cron expression', Date.now())).toBeNull();
  });

  it('honors an explicit timezone', () => {
    // '0 12 * * *' in America/Sao_Paulo (UTC-3) is 15:00 UTC.
    const from = Date.UTC(2024, 0, 1, 0, 0, 0);
    const next = nextCronRunMs('0 12 * * *', from, 'America/Sao_Paulo');
    expect(next).not.toBeNull();
    expect(new Date(next as number).toISOString()).toBe('2024-01-01T15:00:00.000Z');
  });
});
