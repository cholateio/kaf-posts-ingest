import { describe, expect, it } from 'vitest';
import { feedWarnings } from '../feedHealth';

const NOW = new Date('2026-10-10T06:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();

describe('feedWarnings', () => {
    it('is silent for a healthy feed', () => {
        expect(feedWarnings({ entries: 25, dropped: 7, newestIso: hoursAgo(1), maxQuietHours: 24, now: NOW })).toEqual([]);
    });
    it('flags an empty feed', () => {
        expect(feedWarnings({ entries: 0, dropped: 0, newestIso: null, maxQuietHours: 24, now: NOW })).toEqual([
            'feed returned 0 entries',
        ]);
    });
    it('flags a feed whose newest entry is older than its quiet limit', () => {
        expect(feedWarnings({ entries: 25, dropped: 0, newestIso: hoursAgo(30), maxQuietHours: 24, now: NOW })).toEqual([
            'newest entry is 30h old (limit 24h)',
        ]);
    });
    it('flags a relevance gate dropping more than half the feed', () => {
        expect(feedWarnings({ entries: 25, dropped: 13, newestIso: hoursAgo(1), maxQuietHours: 24, now: NOW })).toEqual([
            'relevance gate dropped 13/25 entries',
        ]);
    });
});
