import { describe, expect, it, vi } from 'vitest';
import { fetchVideoItems, hashtagsOf, isoDurationToSeconds, toStreamRow, unavailableRow, type YtVideoItem } from '../youtube';

const NOW = new Date('2026-10-09T12:00:00Z');
const base = (over: Partial<YtVideoItem> & { id: string }): YtVideoItem => ({
    snippet: { channelId: 'UCkJYa9mVS25eHOO9bM7YK3Q', title: 't', publishedAt: '2026-10-01T00:00:00Z', liveBroadcastContent: 'none' },
    contentDetails: { duration: 'P0D' },
    ...over,
});

describe('isoDurationToSeconds', () => {
    it('parses PT1H2M3S / PT4M / P0D', () => {
        expect(isoDurationToSeconds('PT1H2M3S')).toBe(3723);
        expect(isoDurationToSeconds('PT4M')).toBe(240);
        expect(isoDurationToSeconds('P0D')).toBe(0);
    });
});

describe('toStreamRow status derivation', () => {
    it('ended when actualEndTime present', () => {
        const row = toStreamRow(base({ id: 'a'.repeat(11), liveStreamingDetails: { scheduledStartTime: '2026-10-09T10:00:00Z', actualStartTime: '2026-10-09T10:01:00Z', actualEndTime: '2026-10-09T11:00:00Z' }, contentDetails: { duration: 'PT59M' } }), 'rss_live', false, NOW);
        expect(row.status).toBe('ended');
        expect(row.is_premiere).toBe(false); // 59 min > 15 min heuristic
    });
    it('live when started but not ended', () => {
        const row = toStreamRow(base({ id: 'b'.repeat(11), snippet: { channelId: 'c', title: 't', publishedAt: '2026-10-09T09:00:00Z', liveBroadcastContent: 'live' }, liveStreamingDetails: { actualStartTime: '2026-10-09T11:50:00Z' } }), 'rss_live', false, NOW);
        expect(row.status).toBe('live');
        expect(row.is_premiere).toBe(false); // P0D while live => real stream
    });
    it('upcoming + premiere when scheduled and duration already known', () => {
        const row = toStreamRow(base({ id: 'c'.repeat(11), snippet: { channelId: 'c', title: '【歌ってみた】x', publishedAt: '2026-10-09T09:00:00Z', liveBroadcastContent: 'upcoming' }, liveStreamingDetails: { scheduledStartTime: '2026-10-09T13:00:00Z' }, contentDetails: { duration: 'PT3M40S' } }), 'rss_uploads', false, NOW);
        expect(row.status).toBe('upcoming');
        expect(row.is_premiere).toBe(true);
    });
    it('published when no liveStreamingDetails', () => {
        const row = toStreamRow(base({ id: 'd'.repeat(11), contentDetails: { duration: 'PT3M' } }), 'rss_uploads', false, NOW);
        expect(row.status).toBe('published');
        expect(row.scheduled_start).toBeNull();
    });
    it('carries members_only and discovered_via through', () => {
        const row = toStreamRow(base({ id: 'e'.repeat(11) }), 'tweet', true, NOW);
        expect(row.members_only).toBe(true);
        expect(row.discovered_via).toBe('tweet');
        expect(row.updated_at).toBe(NOW.toISOString());
    });
});

describe('fetchVideoItems', () => {
    it('batches by 50 and omits ids the API did not return', async () => {
        const ids = Array.from({ length: 60 }, (_, i) => String(i).padStart(11, 'x'));
        const fetchImpl = vi.fn(async (url: string) => {
            const got = new URL(url).searchParams.get('id')!.split(',');
            // Pretend the last id of each batch was deleted.
            const items = got.slice(0, -1).map((id) => base({ id }));
            return new Response(JSON.stringify({ items }), { status: 200 });
        });
        const map = await fetchVideoItems(ids, 'KEY', fetchImpl as unknown as typeof fetch);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(map.size).toBe(58);
        expect(map.has(ids[49])).toBe(false);
        expect(map.has(ids[59])).toBe(false);
    });
    it('throws on non-200 so the caller can treat the batch as stale', async () => {
        const fetchImpl = vi.fn(async () => new Response('quota', { status: 403 }));
        await expect(fetchVideoItems(['a'.repeat(11)], 'KEY', fetchImpl as unknown as typeof fetch)).rejects.toThrow(/403/);
    });
});

describe('hashtagsOf', () => {
    it('extracts hashtags from a description, deduped, in order', () => {
        const desc = '10月13日(火) 20:00〜「神椿報奏部 vol.65」を生放送！\n出演：春猿火 / ヰ世界情緒\n\n#春猿火 #ヰ世界情緒 #KAMITSUBAKI_STUDIO #神椿無電 #春猿火';
        expect(hashtagsOf(desc)).toEqual(['春猿火', 'ヰ世界情緒', 'KAMITSUBAKI_STUDIO', '神椿無電']);
    });
    it('stops a tag at CJK punctuation and ignores bare #', () => {
        expect(hashtagsOf('#春猿火UNITY』のお話 # x #3 ticket')).toEqual(['春猿火UNITY', '3']);
        expect(hashtagsOf('')).toEqual([]);
    });
});

describe('toStreamRow hashtags', () => {
    it('stores the description hashtags; empty without a description', () => {
        const withDesc = toStreamRow(base({ id: 'e'.repeat(11), snippet: { channelId: 'c', title: 't', publishedAt: '2026-10-09T09:00:00Z', liveBroadcastContent: 'none', description: 'x #花譜 #神椿' } }), 'rss_uploads', false, NOW);
        expect(withDesc.hashtags).toEqual(['花譜', '神椿']);
        expect(toStreamRow(base({ id: 'f'.repeat(11) }), 'rss_uploads', false, NOW).hashtags).toEqual([]);
        expect(unavailableRow('g'.repeat(11), { channel_id: 'c', title: 't', published_at: '2026-10-01T00:00:00Z', discovered_via: 'rss_live' }, NOW).hashtags).toEqual([]);
    });
});
