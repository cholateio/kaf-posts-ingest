import { MEMBERS_ONLY_RE } from './membersOnly';
import { toStreamRow, unavailableRow, type DiscoveredVia, type StreamRow, type YtVideoItem } from './youtube';

export interface Discovery {
    via: DiscoveredVia;
    membersOnly: boolean;
}

export type StaleRow = Pick<StreamRow, 'video_id' | 'channel_id' | 'title' | 'published_at' | 'discovered_via' | 'members_only'>;

export interface AssembleInput {
    newIds: string[];
    discovered: Map<string, Discovery>;
    stale: StaleRow[];
    items: Map<string, YtVideoItem>;
    allowed: Set<string>;
    now: Date;
}

// Invariant (0006 NOT NULL columns): an `unavailable` row is only ever built
// from an existing row's stored metadata. A newly discovered id the API does
// not return is dropped, never written — there is no snippet to fill
// channel_id/title/published_at, and nothing about it is worth keeping.
export function assembleRows({ newIds, discovered, stale, items, allowed, now }: AssembleInput): StreamRow[] {
    const rows: StreamRow[] = [];
    for (const id of newIds) {
        const item = items.get(id);
        if (!item) continue;
        const d = discovered.get(id);
        // Off-roster channel: kept only when an official/talent tweet linked
        // it — a guest live/premiere, or a feat. upload (MIMI『風の名前』feat.
        // ヰ世界情緒, 2026-10-11). Retweeted MVs land here too; the web's
        // classify.ts shows an off-roster upload only when its title/hashtags
        // name a talent, and attributes it to them.
        if (!allowed.has(item.snippet.channelId) && d?.via !== 'tweet') continue;
        const membersOnly = (d?.membersOnly ?? false) || MEMBERS_ONLY_RE.test(item.snippet.title);
        rows.push(toStreamRow(item, d?.via ?? 'rss_uploads', membersOnly, now));
    }
    for (const r of stale) {
        const item = items.get(r.video_id);
        rows.push(item ? toStreamRow(item, r.discovered_via, r.members_only, now) : unavailableRow(r.video_id, r, now));
    }
    return rows;
}
