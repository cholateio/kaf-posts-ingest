/**
 * RSS fetch step. Pulls each configured source, dedupes against existing
 * Posts.external_id, inserts the new entries. Translation is left for the
 * companion `translate.ts` step.
 *
 * Usage:  npm run fetch    (or: tsx scripts/fetch.ts)
 * Env:    SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

// Local dev: read .env. On GitHub Actions the env vars come from the
// workflow file directly, so dotenv finds nothing and is a no-op.
import 'dotenv/config';

import { createClient } from '@supabase/supabase-js';
import Parser from 'rss-parser';

type MediaContent = { $: { url: string; medium?: string } };

const parser = new Parser<Record<string, never>, { 'media:content': MediaContent | MediaContent[] }>({
    defaultRSS: 2.0,
    customFields: {
        item: [['media:content', 'media:content', { keepArray: true }]],
    },
});

// All sources are X (Twitter) feeds. The previous YT source was dropped when
// the frontend removed YouTube content — keeping the call here would just
// burn rss.app quota for rows nothing renders.
const SOURCES = [
    { name: 'KAF Official', feedType: 'official', rssUrl: 'https://rss.app/feeds/TrZl0i4ipQm1dz7k.xml' },
    { name: 'KAF Info', feedType: 'official', rssUrl: 'https://rss.app/feeds/HGY9VajmSLSoYIWC.xml' },
    { name: 'KAF Fan #KAF', feedType: 'fan', rssUrl: 'https://rss.app/feeds/sobCJ2ZL60gmrRKt.xml' },
    { name: 'KAFU #KAFU', feedType: 'kafu', rssUrl: 'https://rss.app/feeds/O6oRYJpoK0nmmzSm.xml' },
] as const;

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

async function main() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) {
        console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
        process.exit(1);
    }

    const db = createClient(url, key);
    let totalFetched = 0;

    for (const source of SOURCES) {
        try {
            console.log(`Fetching ${source.name} (${source.rssUrl})...`);
            const entries = await parseRssFeed(source.rssUrl);

            if (entries.length === 0) {
                console.log(`  ${source.name}: 0 entries in feed`);
                continue;
            }

            const externalIds = entries.map((e) => e.externalId);
            const { data: existing } = await db.from('KAF_Posts').select('external_id').in('external_id', externalIds);

            const existingIds = new Set((existing ?? []).map((p: { external_id: string }) => p.external_id));
            const newEntries = entries.filter((e) => !existingIds.has(e.externalId));

            if (newEntries.length === 0) {
                console.log(`  ${source.name}: 0 new (${entries.length} already exist)`);
                continue;
            }

            const rows = newEntries.map((e) => ({
                source_type: 'x' as const,
                feed_type: source.feedType,
                external_id: e.externalId,
                title: e.title,
                original_text: e.text,
                media_urls: e.mediaUrls,
                published_at: e.publishedAt,
            }));

            const { error: insErr } = await db.from('KAF_Posts').insert(rows);
            if (insErr) throw new Error(`Insert failed: ${insErr.message}`);

            totalFetched += rows.length;
            console.log(`  ${source.name}: ${rows.length} new posts`);
        } catch (err) {
            // Per-source failures must NOT halt the loop — a flaky rss.app endpoint
            // for one feed shouldn't block the others from ingesting.
            console.error(`  ${source.name}: FAILED -`, err);
        }
    }

    console.log(`\nDone. Total new posts: ${totalFetched}`);
}

main();
