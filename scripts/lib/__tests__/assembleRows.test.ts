import { describe, expect, it } from 'vitest';
import { assembleRows, type StaleRow } from '../assembleRows';
import type { YtVideoItem } from '../youtube';

const NOW = new Date('2026-10-09T12:00:00Z');
const ROSTER = new Set(['UCroster0000000000000000']);
const item = (id: string, channelId = 'UCroster0000000000000000'): YtVideoItem => ({
    id,
    snippet: { channelId, title: `title ${id}`, publishedAt: '2026-10-01T00:00:00Z', liveBroadcastContent: 'none' },
    contentDetails: { duration: 'PT3M' },
});
const stale = (id: string): StaleRow => ({
    video_id: id, channel_id: 'UCroster0000000000000000', title: `old ${id}`,
    published_at: '2026-09-01T00:00:00Z', discovered_via: 'rss_live', members_only: false,
});

describe('assembleRows', () => {
    it('drops a newly discovered id the API did not return, keeps the valid ones', () => {
        const items = new Map([['valid000001', item('valid000001')]]);
        const rows = assembleRows({
            newIds: ['valid000001', 'deleted0001'],
            discovered: new Map([
                ['valid000001', { via: 'rss_uploads', membersOnly: false }],
                ['deleted0001', { via: 'tweet', membersOnly: true }],
            ]),
            stale: [], items, allowed: ROSTER, now: NOW,
        });
        expect(rows.map((r) => r.video_id)).toEqual(['valid000001']);
    });
    it('marks a stale existing row unavailable with its stored metadata when the API omits it', () => {
        const rows = assembleRows({
            newIds: [], discovered: new Map(), stale: [stale('gone0000001'), stale('still000001')],
            items: new Map([['still000001', item('still000001')]]), allowed: ROSTER, now: NOW,
        });
        const gone = rows.find((r) => r.video_id === 'gone0000001')!;
        expect(gone.status).toBe('unavailable');
        expect(gone.channel_id).toBe('UCroster0000000000000000');
        expect(gone.title).toBe('old gone0000001');
        expect(gone.published_at).toBe('2026-09-01T00:00:00Z');
        expect(rows.find((r) => r.video_id === 'still000001')!.status).toBe('published');
    });
    it('drops new videos hosted on a non-roster channel', () => {
        const rows = assembleRows({
            newIds: ['guest000001'], discovered: new Map([['guest000001', { via: 'tweet', membersOnly: false }]]),
            stale: [], items: new Map([['guest000001', item('guest000001', 'UCsomeoneelse00000000000')]]), allowed: ROSTER, now: NOW,
        });
        expect(rows).toEqual([]);
    });
    it('carries the tweet members-only hint into a new row', () => {
        const rows = assembleRows({
            newIds: ['member00001'], discovered: new Map([['member00001', { via: 'tweet', membersOnly: true }]]),
            stale: [], items: new Map([['member00001', item('member00001')]]), allowed: ROSTER, now: NOW,
        });
        expect(rows[0].members_only).toBe(true);
        expect(rows[0].discovered_via).toBe('tweet');
    });
});
