export type FeedType = 'official' | 'fan' | 'kafu' | 'rim' | 'harusaruhi' | 'isekaijoucho' | 'ciel';

// One tweet can sit in several feeds (the fan search finds 花譜's own tweets,
// official accounts retweet others), but kaf_posts keeps one row per
// external_id. Whichever feed rss.app refreshed first used to win, so a new
// cover tweet landed in the fan tab (2026-10-10; 5 archived rows). The row
// belongs to the most authoritative feed that has seen it.
const RANK: Record<FeedType, number> = {
    official: 3,
    rim: 2,
    harusaruhi: 2,
    isekaijoucho: 2,
    ciel: 2,
    kafu: 1,
    fan: 0,
};

/** external_ids of `existing` rows that `source` outranks and should retag. */
export function idsToRetag(source: FeedType, existing: { external_id: string; feed_type: string }[]): string[] {
    return existing
        .filter((r) => r.feed_type in RANK && RANK[source] > RANK[r.feed_type as FeedType])
        .map((r) => r.external_id);
}
