export type StreamStatus = 'upcoming' | 'live' | 'ended' | 'published' | 'unavailable';
export type DiscoveredVia = 'rss_live' | 'rss_uploads' | 'tweet';

export interface YtVideoItem {
    id: string;
    snippet: { channelId: string; title: string; description?: string; publishedAt: string; liveBroadcastContent: 'none' | 'upcoming' | 'live' };
    contentDetails?: { duration?: string };
    liveStreamingDetails?: { scheduledStartTime?: string; actualStartTime?: string; actualEndTime?: string };
}

export interface StreamRow {
    video_id: string;
    channel_id: string;
    title: string;
    scheduled_start: string | null;
    actual_start: string | null;
    actual_end: string | null;
    published_at: string;
    status: StreamStatus;
    is_premiere: boolean;
    members_only: boolean;
    discovered_via: DiscoveredVia;
    hashtags: string[];
    updated_at: string;
}

const API = 'https://www.googleapis.com/youtube/v3/videos';
const BATCH = 50; // videos.list hard cap per request; 1 quota unit regardless of count.
// Spec verification point 4: after a premiere ends the payload looks like an
// ended live stream; anything this short is almost certainly a premiere.
const PREMIERE_MAX_SECONDS = 15 * 60;

export function isoDurationToSeconds(iso: string): number {
    const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
    if (!m) return 0;
    const [, d, h, mi, s] = m.map((x) => Number(x ?? 0));
    return d * 86400 + h * 3600 + mi * 60 + s;
}

export async function fetchVideoItems(ids: string[], apiKey: string, fetchImpl: typeof fetch = fetch): Promise<Map<string, YtVideoItem>> {
    const out = new Map<string, YtVideoItem>();
    for (let i = 0; i < ids.length; i += BATCH) {
        const chunk = ids.slice(i, i + BATCH);
        const url = `${API}?part=snippet,contentDetails,liveStreamingDetails&id=${chunk.join(',')}&key=${apiKey}`;
        const res = await fetchImpl(url);
        if (!res.ok) throw new Error(`videos.list HTTP ${res.status}`);
        const body = (await res.json()) as { items?: YtVideoItem[] };
        for (const item of body.items ?? []) out.set(item.id, item);
    }
    return out;
}

// Mirrored in kaf-observatory/src/lib/schedule/server/youtube.ts. A tag ends
// at whitespace or CJK punctuation ("#春猿火UNITY』" → 春猿火UNITY); which
// talent a tag names is decided by the web's roster at read time.
const HASHTAG_RE = /#([^\s#、。，,.!！?？「」『』（）()【】]+)/g;
export function hashtagsOf(description: string): string[] {
    const out: string[] = [];
    for (const m of description.matchAll(HASHTAG_RE)) if (!out.includes(m[1])) out.push(m[1]);
    return out;
}

export function toStreamRow(item: YtVideoItem, discoveredVia: DiscoveredVia, membersOnly: boolean, now: Date): StreamRow {
    const lsd = item.liveStreamingDetails;
    const durationS = isoDurationToSeconds(item.contentDetails?.duration ?? 'P0D');
    let status: StreamStatus;
    if (!lsd) status = 'published';
    else if (lsd.actualEndTime) status = 'ended';
    else if (lsd.actualStartTime) status = 'live';
    else status = 'upcoming';
    const isPremiere =
        !!lsd && (status === 'ended' ? durationS > 0 && durationS <= PREMIERE_MAX_SECONDS : durationS > 0);
    return {
        video_id: item.id,
        channel_id: item.snippet.channelId,
        title: item.snippet.title,
        scheduled_start: lsd?.scheduledStartTime ?? null,
        actual_start: lsd?.actualStartTime ?? null,
        actual_end: lsd?.actualEndTime ?? null,
        published_at: item.snippet.publishedAt,
        status,
        is_premiere: isPremiere,
        members_only: membersOnly,
        discovered_via: discoveredVia,
        hashtags: hashtagsOf(item.snippet.description ?? ''),
        updated_at: now.toISOString(),
    };
}

export function unavailableRow(
    videoId: string,
    existing: Pick<StreamRow, 'channel_id' | 'title' | 'published_at' | 'discovered_via'>,
    now: Date,
): StreamRow {
    return {
        video_id: videoId,
        ...existing,
        scheduled_start: null,
        actual_start: null,
        actual_end: null,
        status: 'unavailable',
        is_premiere: false,
        members_only: false,
        hashtags: [],
        updated_at: now.toISOString(),
    };
}
