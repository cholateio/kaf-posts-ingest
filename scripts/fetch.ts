/**
 * RSS fetch step. Pulls each configured source, dedupes against existing
 * Posts.external_id, inserts the new entries. Translation is left for the
 * companion `translate.ts` step.
 *
 * Usage:  pnpm run fetch    (or: tsx scripts/fetch.ts)
 * Env:    SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

// Local dev: read .env. On GitHub Actions the env vars come from the
// workflow file directly, so dotenv finds nothing and is a no-op.
import 'dotenv/config';

import { createClient } from '@supabase/supabase-js';
import Parser from 'rss-parser';
import { appendFileSync } from 'node:fs';
import { feedWarnings } from './lib/feedHealth';
import { tweetBody } from './lib/tweetBody';
import { memberships, membershipPatches, ownerOf, type ExistingRow, type FeedType } from './lib/feedRank';
import { tweetAuthor } from './lib/tweetAuthor';

type MediaContent = { $: { url: string; medium?: string } };

const parser = new Parser<Record<string, never>, { 'media:content': MediaContent | MediaContent[] }>({
    defaultRSS: 2.0,
    customFields: {
        item: [['media:content', 'media:content', { keepArray: true }]],
    },
});

interface Source {
    name: string;
    // Talent ids match kaf-observatory/src/lib/schedule/roster.ts so a Reader
    // tab per talent can key on them later. Only official/fan/kafu have tabs
    // (and translation) today; talent rows exist for streams.ts.
    feedType: FeedType;
    rssUrl: string;
    /**
     * Relevance gate for search-backed feeds only.
     *
     * The fan and kafu feeds are rss.app wrappers around `x.com/search?q=花譜`
     * and `x.com/search?q=可不 kafu`. X returns loosely related results — CJK
     * queries get token-split (`板倉可奈　永久不滅` matches 可+不; `瀧廉太郎の
     * 「花」の自筆譜` matches 花+譜) and the Top tab expands further. Measured
     * against 5784 archived rows: 10% of fan and 9% of kafu entries mention no
     * form of the subject at all, with zero legitimate posts caught by these
     * patterns. Account timelines need no gate. Tested against the tweet body
     * only (tweetBody.ts): the trailing "— @handle date" line would let
     * @KAFfeine_max-style handles through (45/3358 archived fan rows).
     */
    mustMatch?: RegExp;
    /**
     * "Fan = fans" (decision 2026-10-11): a hit authored by a known account
     * is filed under that account only and never gets `fan` membership
     * (feedRank.memberships). Storing it under the account at once also
     * keeps the tweet if the official feed is down (codex review
     * 2026-10-10). The kafu search is topical and does not set this: a
     * talent's tweet about 可不 stays in the Kafu tab. Retweets are
     * unaffected — their URL is the original author's.
     */
    fansOnly?: true;
    /**
     * Warn when the feed's newest entry is older than this. Set from the
     * longest gap between consecutive archived posts (2026-07..10): fan 11.5h,
     * kafu 39h, account timelines ~7d.
     */
    maxQuietHours: number;
}

const TIMELINE_QUIET_H = 10 * 24;

// All sources are X (Twitter) feeds. The previous YT source was dropped when
// the frontend removed YouTube content — keeping the call here would just
// burn rss.app quota for rows nothing renders.
const SOURCES: Source[] = [
    {
        name: 'KAF Official',
        feedType: 'official',
        rssUrl: 'https://rss.app/feeds/TrZl0i4ipQm1dz7k.xml',
        maxQuietHours: TIMELINE_QUIET_H,
    },
    {
        name: 'KAF Info',
        feedType: 'official',
        rssUrl: 'https://rss.app/feeds/HGY9VajmSLSoYIWC.xml',
        maxQuietHours: TIMELINE_QUIET_H,
    },
    // Two wrappers of the same X search: rss.app's default (Top tab) and
    // `f=live` (Latest). Snapshots 2026-10-10 showed each one missing posts
    // the other had (10/28 and 6/31 within shared windows), and misses never
    // arrived later. Duplicates collapse on external_id.
    {
        name: 'KAF Fan #KAF',
        feedType: 'fan',
        rssUrl: 'https://rss.app/feeds/sobCJ2ZL60gmrRKt.xml',
        mustMatch: /花譜|kaf|カフ|可不/i,
        fansOnly: true,
        maxQuietHours: 24,
    },
    {
        name: 'KAF Fan #KAF (latest)',
        feedType: 'fan',
        rssUrl: 'https://rss.app/feeds/u9s6xz2Y3aj9qbFW.xml',
        mustMatch: /花譜|kaf|カフ|可不/i,
        fansOnly: true,
        maxQuietHours: 24,
    },
    {
        name: 'KAFU #KAFU',
        feedType: 'kafu',
        rssUrl: 'https://rss.app/feeds/O6oRYJpoK0nmmzSm.xml',
        mustMatch: /可不|kafu/i,
        maxQuietHours: 72,
    },
    // Talent main accounts (not the *_staff / *_info ones): they retweet the
    // staff announcements and carry the day-of "starting soon" posts.
    // Members-only streams are absent from the public UULV playlists, so
    // these tweets are the only way streams.ts learns about them.
    { name: 'RIM', feedType: 'rim', rssUrl: 'https://rss.app/feeds/4bNdyMswbQ4dyGRm.xml', maxQuietHours: TIMELINE_QUIET_H },
    { name: 'Harusaruhi', feedType: 'harusaruhi', rssUrl: 'https://rss.app/feeds/WzmRw0SvxXvIKKDj.xml', maxQuietHours: TIMELINE_QUIET_H },
    { name: 'Isekaijoucho', feedType: 'isekaijoucho', rssUrl: 'https://rss.app/feeds/q34CgypDhDb9uPSi.xml', maxQuietHours: TIMELINE_QUIET_H },
    { name: 'CIEL', feedType: 'ciel', rssUrl: 'https://rss.app/feeds/fBrcroINXq6Bw3R5.xml', maxQuietHours: TIMELINE_QUIET_H },
];

interface RssEntry {
    externalId: string;
    title: string;
    text: string;
    publishedAt: string;
    mediaUrls: string[];
}

function htmlToText(html: string): string {
    return html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

async function parseRssFeed(feedUrl: string): Promise<RssEntry[]> {
    const response = await fetch(feedUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const rawXml = await response.text();
    // rss.app occasionally emits unescaped `&` in URLs/titles which crashes
    // the XML parser. Escape any ampersand that isn't already part of a known
    // entity reference.
    const sanitized = rawXml.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/g, '&amp;');
    const feed = await parser.parseString(sanitized);

    return feed.items.map((item) => {
        const urls: string[] = [];
        if (item.enclosure?.url) urls.push(item.enclosure.url);
        const mediaContent = item['media:content'];
        if (mediaContent) {
            const items = Array.isArray(mediaContent) ? mediaContent : [mediaContent];
            for (const m of items) {
                if (m.$?.url) urls.push(m.$.url);
            }
        }
        return {
            externalId: item.link ?? item.guid ?? item.title ?? '',
            title: item.title ?? '',
            text: htmlToText(item.content ?? item.contentSnippet ?? item.title ?? ''),
            publishedAt: item.isoDate ?? new Date().toISOString(),
            mediaUrls: urls,
        };
    });
}

interface FeedReport {
    name: string;
    entries: number;
    dropped: number;
    inserted: number;
    retagged: number;
    joined: number;
    newestIso: string | null;
    warnings: string[];
}

// The run badge stays green whatever happens per feed, so problems surface as
// workflow annotations (listed on the run page) plus a per-feed table in the
// job summary; the table doubles as the noise baseline for feed tuning.
function reportFeedHealth(report: FeedReport[]) {
    for (const r of report) {
        for (const w of r.warnings) console.log(`::warning title=Feed health::${r.name}: ${w}`);
    }
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (!summaryPath) return;
    const now = Date.now();
    const lines = [
        '### Feeds',
        '| feed | entries | dropped | new | retagged | joined | newest | warnings |',
        '| --- | --: | --: | --: | --: | --: | --: | --- |',
        ...report.map((r) => {
            const age = r.newestIso ? `${Math.floor((now - Date.parse(r.newestIso)) / 3600_000)}h ago` : '-';
            return `| ${r.name} | ${r.entries} | ${r.dropped} | ${r.inserted} | ${r.retagged} | ${r.joined} | ${age} | ${r.warnings.join('; ') || 'ok'} |`;
        }),
        '',
    ];
    appendFileSync(summaryPath, lines.join('\n'));
}

async function main() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) {
        console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
        process.exit(1);
    }

    const db = createClient(url, key);
    let totalFetched = 0;

    const report: FeedReport[] = [];

    for (const source of SOURCES) {
        const row: FeedReport = { name: source.name, entries: 0, dropped: 0, inserted: 0, retagged: 0, joined: 0, newestIso: null, warnings: [] };
        report.push(row);
        try {
            console.log(`Fetching ${source.name} (${source.rssUrl})...`);
            const entries = await parseRssFeed(source.rssUrl);
            row.entries = entries.length;
            row.newestIso = entries.reduce<string | null>((max, e) => (max && max > e.publishedAt ? max : e.publishedAt), null);

            const relevant = source.mustMatch
                ? entries.filter((e) => source.mustMatch!.test(tweetBody(e.text)))
                : entries;
            const typesOf = (e: RssEntry): FeedType[] => memberships(source.feedType, tweetAuthor(e.externalId), !!source.fansOnly);
            row.dropped = entries.length - relevant.length;
            row.warnings = feedWarnings({ ...row, maxQuietHours: source.maxQuietHours, now: new Date() });

            if (entries.length === 0) {
                console.log(`  ${source.name}: 0 entries in feed`);
                continue;
            }
            if (row.dropped > 0) {
                console.log(`  ${source.name}: dropped ${row.dropped} off-topic entries`);
            }
            if (relevant.length === 0) {
                console.log(`  ${source.name}: 0 relevant entries in feed`);
                continue;
            }

            const externalIds = relevant.map((e) => e.externalId);
            const { data: existing, error: exErr } = await db
                .from('kaf_posts')
                .select('external_id, feed_type, seen_in')
                .in('external_id', externalIds);
            if (exErr) throw new Error(`Select existing failed: ${exErr.message}`);

            // Entries resolve to different membership sets (known authors), so
            // group existing rows by set before computing patches.
            const typesById = new Map(relevant.map((e) => [e.externalId, typesOf(e)]));
            const byTypes = new Map<string, { types: FeedType[]; rows: ExistingRow[] }>();
            for (const ex of existing ?? []) {
                const types = typesById.get(ex.external_id) ?? [source.feedType];
                const key = types.join(',');
                const g = byTypes.get(key) ?? { types, rows: [] };
                g.rows.push(ex);
                byTypes.set(key, g);
            }
            for (const { types, rows: rowsOfTypes } of byTypes.values()) {
                for (const { ids, patch } of membershipPatches(types, rowsOfTypes)) {
                    const { error: upErr } = await db.from('kaf_posts').update(patch).in('external_id', ids);
                    if (upErr) throw new Error(`Membership update failed: ${upErr.message}`);
                    row.joined += ids.length;
                    if (patch.feed_type) row.retagged += ids.length;
                    console.log(`  ${source.name}: ${ids.length} rows -> seen_in ${JSON.stringify(patch.seen_in)}${patch.feed_type ? ` (owner ${patch.feed_type})` : ''}`);
                }
            }

            const existingIds = new Set((existing ?? []).map((p: { external_id: string }) => p.external_id));
            const newEntries = relevant.filter((e) => !existingIds.has(e.externalId));

            if (newEntries.length === 0) {
                console.log(`  ${source.name}: 0 new (${relevant.length} already exist)`);
                continue;
            }

            const rows = newEntries.map((e) => ({
                source_type: 'x' as const,
                feed_type: ownerOf(typesOf(e)),
                seen_in: typesOf(e),
                external_id: e.externalId,
                title: e.title,
                original_text: e.text,
                media_urls: e.mediaUrls,
                published_at: e.publishedAt,
            }));

            const { error: insErr } = await db.from('kaf_posts').insert(rows);
            if (insErr) throw new Error(`Insert failed: ${insErr.message}`);

            totalFetched += rows.length;
            row.inserted = rows.length;
            const overridden = rows.filter((r) => r.feed_type !== source.feedType).length;
            console.log(`  ${source.name}: ${rows.length} new posts${overridden ? ` (${overridden} stored as ${[...new Set(rows.map((r) => r.feed_type))].filter((t) => t !== source.feedType).join('/')})` : ''}`);
        } catch (err) {
            // Per-source failures must NOT halt the loop — a flaky rss.app endpoint
            // for one feed shouldn't block the others from ingesting.
            console.error(`  ${source.name}: FAILED -`, err);
            row.warnings.push(`FAILED - ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    reportFeedHealth(report);
    console.log(`\nDone. Total new posts: ${totalFetched}`);
}

main();
