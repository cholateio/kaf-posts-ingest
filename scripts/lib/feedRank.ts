export type FeedType = 'official' | 'fan' | 'kafu' | 'rim' | 'harusaruhi' | 'isekaijoucho' | 'ciel';

// One tweet can sit in several feeds (the fan search finds 花譜's own tweets,
// official accounts retweet talents, talents retweet official). kaf_posts
// keeps one row per external_id: `seen_in` lists every feed that saw it
// (Reader tabs filter on containment) and `feed_type` is the single owner
// used for translation priority — the highest-ranked member. Rank is
// deliberate: talents sit above kafu/fan (decision 2026-10-10).
const RANK: Record<FeedType, number> = {
    official: 3,
    rim: 2,
    harusaruhi: 2,
    isekaijoucho: 2,
    ciel: 2,
    kafu: 1,
    fan: 0,
};

// Lowercase X handles (tweetAuthor lowercases) of the accounts that have a
// feed of their own. Must stay in sync with the account feeds in
// scripts/fetch.ts SOURCES and kaf-observatory lib/reader/retweet.ts.
export const KNOWN_AUTHORS: Record<string, FeedType> = {
    virtual_kaf: 'official',
    kaf_info: 'official',
    rim_virtual: 'rim',
    harusaruhi: 'harusaruhi',
    isekaijoucho: 'isekaijoucho',
    ciel_vanillasky: 'ciel',
};

/**
 * Feeds an entry belongs to when `source` fetched it: the source plus the
 * author's own feed, which contains the tweet by definition whether or not
 * its 25-item window still shows it. The topical kafu search follows the
 * same rule. A fans-only feed is the exception: a known account's tweet is
 * that account's, not a fan post ("fan = fans", decision 2026-10-11).
 */
export function memberships(source: FeedType, author: string | null, fansOnly: boolean): FeedType[] {
    const own = author ? KNOWN_AUTHORS[author] : undefined;
    if (fansOnly) return [own ?? source];
    return own && own !== source ? [source, own] : [source];
}

/** Highest-ranked type; ties keep the earlier element. */
export function ownerOf(types: FeedType[]): FeedType {
    return types.reduce((best, t) => (RANK[t] > RANK[best] ? t : best));
}

export interface ExistingRow {
    external_id: string;
    feed_type: string;
    seen_in: string[];
}

export interface RowPatch {
    ids: string[];
    patch: { feed_type?: FeedType; seen_in: string[] };
}

/**
 * Updates for rows that already exist: append missing memberships, retag the
 * owner only when `types` outranks it. Rows needing the same patch share one
 * entry so fetch.ts issues one UPDATE per distinct patch.
 */
export function membershipPatches(types: FeedType[], existing: ExistingRow[]): RowPatch[] {
    const groups = new Map<string, RowPatch>();
    const top = ownerOf(types);
    for (const r of existing) {
        const seen = [...r.seen_in, ...types.filter((t) => !r.seen_in.includes(t))];
        const stored = r.feed_type in RANK ? RANK[r.feed_type as FeedType] : Infinity;
        const retag = RANK[top] > stored;
        if (seen.length === r.seen_in.length && !retag) continue;
        const patch: RowPatch['patch'] = retag ? { feed_type: top, seen_in: seen } : { seen_in: seen };
        const key = JSON.stringify(patch);
        const g = groups.get(key);
        if (g) g.ids.push(r.external_id);
        else groups.set(key, { ids: [r.external_id], patch });
    }
    return [...groups.values()];
}
