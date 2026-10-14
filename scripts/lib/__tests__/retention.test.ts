import { describe, it, expect } from 'vitest';
import { isRetained, RETAIN_FROM_MS, snowflakeMs } from '../retention';

// Real rows: the last tweet before the floor and the first one after it.
const BEFORE = 'https://x.com/runaboutstella7/status/2105311249542357373'; // 2026-09-30T14:58:11.339Z
const AFTER = 'https://x.com/qh2tu/status/2105327724521001067'; // 2026-09-30T16:03:39.280Z

describe('snowflakeMs', () => {
    it('decodes the tweet time from a status URL', () => {
        expect(new Date(snowflakeMs(AFTER)!).toISOString()).toBe('2026-09-30T16:03:39.280Z');
    });
    it('returns null when the id has no status number', () => {
        expect(snowflakeMs('https://x.com/someone')).toBeNull();
    });
});

describe('isRetained', () => {
    it('pins the floor to 2026-10-01 00:00 Taiwan time', () => {
        expect(new Date(RETAIN_FROM_MS).toISOString()).toBe('2026-09-30T16:00:00.000Z');
    });
    it('keeps a tweet whose id and date are both after the floor', () => {
        expect(isRetained(AFTER, '2026-09-30T16:03:00.000Z')).toBe(true);
    });
    it('drops a tweet whose id and date are both before the floor', () => {
        expect(isRetained(BEFORE, '2026-09-30T14:58:00.000Z')).toBe(false);
    });
    it('drops an old tweet whose missing RSS date was replaced with "now"', () => {
        expect(isRetained(BEFORE, '2026-10-14T08:00:00.000Z')).toBe(false);
    });
    it('drops a tweet the DB deleted by published_at even if its id is just past the floor', () => {
        expect(isRetained(AFTER, '2026-09-30T15:59:00.000Z')).toBe(false);
    });
    it('keeps a post published exactly at the floor', () => {
        expect(isRetained('https://x.com/someone', '2026-09-30T16:00:00.000Z')).toBe(true);
    });
    it('drops a post one millisecond before the floor', () => {
        expect(isRetained('https://x.com/someone', '2026-09-30T15:59:59.999Z')).toBe(false);
    });
    it('falls back to the id when the date is unparseable', () => {
        expect(isRetained(BEFORE, 'not a date')).toBe(false);
        expect(isRetained(AFTER, 'not a date')).toBe(true);
    });
    it('keeps an entry with neither a status id nor a parseable date', () => {
        expect(isRetained('https://x.com/someone', 'not a date')).toBe(true);
    });
});
