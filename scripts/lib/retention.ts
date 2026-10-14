// kaf_posts rows published before this instant were deleted on 2026-10-14
// (kaf-observatory migration 0009). rss.app feeds still list some of those
// tweets; without this floor fetch.ts would re-insert them as new and
// translate.ts would spend Gemini quota on them again.
export const RETAIN_FROM_MS = Date.parse('2026-10-01T00:00:00+08:00');

// X ids are snowflakes: the top bits are ms since the Twitter epoch.
const TWITTER_EPOCH_MS = 1288834974657n;

export function snowflakeMs(externalId: string): number | null {
    const m = /\/status\/(\d+)/.exec(externalId);
    return m ? Number((BigInt(m[1]) >> 22n) + TWITTER_EPOCH_MS) : null;
}

// Both clocks must clear the floor. The id survives a missing RSS date
// (fetch.ts substitutes "now"); publishedAt is what migration 0009 deleted
// by, and rss.app rounds it to the minute, so checking only the id would
// re-admit a few rows the migration removed.
export function isRetained(externalId: string, publishedAtIso: string): boolean {
    const byId = snowflakeMs(externalId);
    const byDate = Date.parse(publishedAtIso);
    if (byId !== null && byId < RETAIN_FROM_MS) return false;
    if (!Number.isNaN(byDate) && byDate < RETAIN_FROM_MS) return false;
    return true;
}
