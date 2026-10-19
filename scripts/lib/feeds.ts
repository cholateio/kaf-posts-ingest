// rss.app feed URLs are paid capabilities: anyone holding one can poll it on
// our plan. The ids live only in the RSS_FEEDS secret / gitignored .env as a
// JSON object { "<key>": "<rss.app feed id>" }; the repo names feeds by key.
const ID_RE = /^[A-Za-z0-9_]+$/;

export function parseFeeds(raw: string | undefined): Record<string, string> {
    if (!raw || !raw.trim()) {
        throw new Error('RSS_FEEDS is not set (JSON object: feed key -> rss.app feed id)');
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error('RSS_FEEDS is not valid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('RSS_FEEDS must be a JSON object');
    }
    const feeds: Record<string, string> = {};
    for (const [key, id] of Object.entries(parsed)) {
        if (typeof id !== 'string' || !ID_RE.test(id)) {
            throw new Error(`RSS_FEEDS["${key}"] is not an rss.app feed id`);
        }
        feeds[key] = id;
    }
    return feeds;
}

let cache: Record<string, string> | undefined;

export function feedUrl(key: string, env: NodeJS.ProcessEnv = process.env): string {
    const feeds = env === process.env ? (cache ??= parseFeeds(env.RSS_FEEDS)) : parseFeeds(env.RSS_FEEDS);
    const id = feeds[key];
    if (!id) throw new Error(`RSS_FEEDS has no entry for "${key}"`);
    return `https://rss.app/feeds/${id}.xml`;
}
