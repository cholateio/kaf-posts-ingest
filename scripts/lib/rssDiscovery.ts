// Channel RSS (channel_id=) is capped at 15 entries and drowned in #shorts;
// the auto playlists are the usable feeds: UULV = live streams only,
// UULF = long-form uploads (no shorts). Both are "UU" + role + channel id
// minus its "UC" prefix. No API key, no quota.
export function playlistFeedUrl(channelId: string, kind: 'live' | 'uploads'): string {
    const suffix = channelId.replace(/^UC/, '');
    const prefix = kind === 'live' ? 'UULV' : 'UULF';
    return `https://www.youtube.com/feeds/videos.xml?playlist_id=${prefix}${suffix}`;
}

export function videoIdsFromYoutubeFeed(xml: string): string[] {
    const out: string[] = [];
    for (const m of xml.matchAll(/<yt:videoId>([A-Za-z0-9_-]{11})<\/yt:videoId>/g)) {
        if (!out.includes(m[1])) out.push(m[1]);
    }
    return out;
}
