export interface FeedSnapshot {
    entries: number;
    newestIso: string | null;
    maxQuietHours: number;
    now: Date;
}

// An rss.app X feed can break without an HTTP error: it keeps serving the
// same 25 stale items, or an empty channel. Newest-entry age is the only
// signal that survives that.
export function feedWarnings({ entries, newestIso, maxQuietHours, now }: FeedSnapshot): string[] {
    if (entries === 0) return ['feed returned 0 entries'];
    const out: string[] = [];
    if (newestIso) {
        const ageH = Math.floor((now.getTime() - Date.parse(newestIso)) / 3600_000);
        if (ageH > maxQuietHours) out.push(`newest entry is ${ageH}h old (limit ${maxQuietHours}h)`);
    }
    return out;
}
