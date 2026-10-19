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

// GitHub masks the RSS_FEEDS secret only as a whole string; each id must be
// registered on its own or it shows up in public Actions logs (fetch errors
// carry the URL).
function loadProcessFeeds(): Record<string, string> {
    const feeds = parseFeeds(process.env.RSS_FEEDS);
    if (process.env.GITHUB_ACTIONS === 'true') {
        for (const id of Object.values(feeds)) console.log(`::add-mask::${id}`);
    }
    return feeds;
}

export function feedUrl(key: string, env: NodeJS.ProcessEnv = process.env): string {
    const feeds = env === process.env ? (cache ??= loadProcessFeeds()) : parseFeeds(env.RSS_FEEDS);
    const id = feeds[key];
    if (!id) throw new Error(`RSS_FEEDS has no entry for "${key}"`);
    return `https://rss.app/feeds/${id}.xml`;
}

// For log lines: never print a feed id, even outside CI.
export function redactFeedUrls(text: string): string {
    return text.replace(/rss\.app\/feeds\/[A-Za-z0-9_]+/g, 'rss.app/feeds/***');
}
