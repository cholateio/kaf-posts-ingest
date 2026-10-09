// Channel RSS (channel_id=) is capped at 15 entries and drowned in #shorts;
// the auto playlists are the usable feeds: UULV = live streams only,
// UULF = long-form uploads (no shorts). Both are "UU" + role + channel id
// minus its "UC" prefix. No API key, no quota.
export function playlistId(channelId: string, kind: 'live' | 'uploads'): string {
    const suffix = channelId.replace(/^UC/, '');
    return `${kind === 'live' ? 'UULV' : 'UULF'}${suffix}`;
}

export function playlistFeedUrl(channelId: string, kind: 'live' | 'uploads'): string {
    return `https://www.youtube.com/feeds/videos.xml?playlist_id=${playlistId(channelId, kind)}`;
}

export function videoIdsFromYoutubeFeed(xml: string): string[] {
    const out: string[] = [];
    for (const m of xml.matchAll(/<yt:videoId>([A-Za-z0-9_-]{11})<\/yt:videoId>/g)) {
        if (!out.includes(m[1])) out.push(m[1]);
    }
    return out;
}

export interface PlaylistItemsPayload {
    items?: { contentDetails?: { videoId?: string } }[];
}

export function playlistItemsVideoIds(body: PlaylistItemsPayload): string[] {
    const out: string[] = [];
    for (const item of body.items ?? []) {
        const id = item.contentDetails?.videoId;
        if (id && !out.includes(id)) out.push(id);
    }
    return out;
}

// Observed 2026-10-09: GitHub Actions runners get HTTP 404/500 from the
// playlist RSS endpoints (IP-based; any User-Agent works from a residential
// IP). playlistItems.list accepts the same UULV/UULF ids for 1 quota unit,
// so it is the fallback when the free feed is blocked.
export async function fetchPlaylistVideoIds(
    channelId: string,
    kind: 'live' | 'uploads',
    apiKey: string,
    fetchImpl: typeof fetch = fetch,
): Promise<{ ids: string[]; via: 'rss' | 'api' }> {
    const rss = await fetchImpl(playlistFeedUrl(channelId, kind));
    if (rss.ok) return { ids: videoIdsFromYoutubeFeed(await rss.text()), via: 'rss' };
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=15&playlistId=${playlistId(channelId, kind)}&key=${apiKey}`;
    const api = await fetchImpl(url);
    if (!api.ok) throw new Error(`rss HTTP ${rss.status}, playlistItems HTTP ${api.status}`);
    return { ids: playlistItemsVideoIds((await api.json()) as PlaylistItemsPayload), via: 'api' };
}
