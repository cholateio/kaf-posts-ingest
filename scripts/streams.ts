/**
 * Live-schedule discovery step. Collects YouTube video ids from each roster
 * channel's live/uploads RSS and from tweet links, looks the new ones up on
 * the Data API, refreshes stale upcoming/live rows, and upserts kaf_streams.
 *
 * Usage:  pnpm run streams
 * Env:    SUPABASE_URL, SUPABASE_SERVICE_KEY, YOUTUBE_API_KEY
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { fetchPlaylistVideoIds } from './lib/rssDiscovery';
import { tweetMembersOnlyHints } from './lib/membersOnly';
import { assembleRows, type Discovery, type StaleRow } from './lib/assembleRows';
import { fetchVideoItems, type DiscoveredVia } from './lib/youtube';

// Keep in sync with kaf-observatory/src/lib/schedule/roster.ts. Drift only
// costs tweet-discovered members-only streams; public streams are also
// discovered live by the web API's own RSS scan.
export const STREAM_CHANNEL_IDS: string[] = [
    'UCQ1U65-CQdIoZ2_NA4Z4F7A', // 花譜 music
    'UCkJYa9mVS25eHOO9bM7YK3Q', // 花譜 観測部 (stream)
    'UCfBkUgaJ6eqYA9_TX2cmq9A', // 理芽 music
    'UCE7gtjLeZKNXLp5YURzYYeg', // 春猿火 music
    'UCah4_WVjmr8XA7i5aigwV-Q', // ヰ世界情緒 music
    'UCZYl1o6ftRLKZP6U4KjQl3g', // 理芽 STRANGE GIRL CLUB (stream)
    'UC5BzXtjnKt1fjEDjEJwx5JA', // 春猿火 台風倶楽部 (stream)
    'UC3VN9h8fokwB2XURWHNcdWw', // ヰ世界情緒 電子通信部 (stream)
    'UC7Gow-kNHq21oejSIDg9PAg', // 幸祜 music
    'UCyCbd63S29BuFOkJC2-aR4g', // 幸祜 幸福拡張部電脳科 (stream)
    'UCAOhUv73jM5iCpOhuJOQzxA', // KAMITSUBAKI STUDIO (group)
    'UCfiSo8tO3WPU-8YOgr4Ba6g', // V.W.P (group)
];

// rss.app tweet feeds scanned for youtube links only; nothing is written to
// kaf_posts from here (that would leak into the Reader's "all" tab).
export const TWEET_FEEDS: string[] = [
    'https://rss.app/feeds/HGY9VajmSLSoYIWC.xml', // @kaf_info
];

const STALE_REFRESH_MS = 30 * 60 * 1000;
const REFRESH_CAP = 50;

async function getText(url: string): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
}

async function main() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    const ytKey = process.env.YOUTUBE_API_KEY;
    if (!url || !key || !ytKey) {
        console.error('Missing SUPABASE_URL, SUPABASE_SERVICE_KEY or YOUTUBE_API_KEY');
        process.exit(1);
    }
    const db = createClient(url, key);
    const now = new Date();

    // 1+2. Discover: id -> how we found it (+ members-only hint from tweets).
    const discovered = new Map<string, Discovery>();
    const note = (id: string, via: DiscoveredVia, membersOnly = false) => {
        const prev = discovered.get(id);
        discovered.set(id, { via: prev?.via ?? via, membersOnly: (prev?.membersOnly ?? false) || membersOnly });
    };
    let apiFallbacks = 0;
    for (const cid of STREAM_CHANNEL_IDS) {
        for (const kind of ['live', 'uploads'] as const) {
            try {
                const { ids: found, via } = await fetchPlaylistVideoIds(cid, kind, ytKey);
                if (via === 'api') apiFallbacks++;
                for (const id of found) note(id, kind === 'live' ? 'rss_live' : 'rss_uploads');
            } catch (err) {
                console.error(`  playlist ${kind} ${cid}: FAILED -`, err);
            }
        }
    }
    if (apiFallbacks) console.log(`  rss blocked for ${apiFallbacks} playlists; used playlistItems.list (${apiFallbacks} quota units)`);
    for (const feed of TWEET_FEEDS) {
        try {
            const xml = await getText(feed);
            // Per <item>: a members-only hint is attributed per link (see membersOnly.ts).
            for (const item of xml.split(/<item>/).slice(1)) {
                for (const [id, membersOnly] of tweetMembersOnlyHints(item)) note(id, 'tweet', membersOnly);
            }
        } catch (err) {
            console.error(`  tweet feed ${feed}: FAILED -`, err);
        }
    }
    console.log(`Discovered ${discovered.size} video ids`);

    // 3. Which are new?
    const ids = [...discovered.keys()];
    const { data: existingRows, error: exErr } = await db
        .from('kaf_streams')
        .select('video_id')
        .in('video_id', ids.length ? ids : ['-']);
    if (exErr) throw new Error(`select existing failed: ${exErr.message}`);
    const existing = new Set((existingRows ?? []).map((r) => r.video_id as string));
    const newIds = ids.filter((id) => !existing.has(id));

    // 5. Stale upcoming/live rows to refresh (bounded).
    const staleBefore = new Date(now.getTime() - STALE_REFRESH_MS).toISOString();
    const { data: staleRows, error: stErr } = await db
        .from('kaf_streams')
        .select('video_id, channel_id, title, published_at, discovered_via, members_only')
        .in('status', ['upcoming', 'live'])
        .lt('updated_at', staleBefore)
        .limit(REFRESH_CAP);
    if (stErr) throw new Error(`select stale failed: ${stErr.message}`);
    const stale = (staleRows ?? []) as StaleRow[];

    // 4. One API pass for both sets.
    const lookup = [...new Set([...newIds, ...stale.map((r) => r.video_id)])];
    if (lookup.length === 0) {
        console.log('Nothing new or stale. Done.');
        return;
    }
    const items = await fetchVideoItems(lookup, ytKey);
    const rows = assembleRows({ newIds, discovered, stale, items, allowed: new Set(STREAM_CHANNEL_IDS), now });

    // 6. Upsert.
    if (rows.length) {
        const { error: upErr } = await db.from('kaf_streams').upsert(rows, { onConflict: 'video_id' });
        if (upErr) throw new Error(`upsert failed: ${upErr.message}`);
    }
    console.log(`Done. new=${rows.length - stale.length} refreshed=${stale.length}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
