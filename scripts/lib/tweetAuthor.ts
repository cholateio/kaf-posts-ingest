// rss.app's <link> for a search-feed item is the tweet's own URL, so the
// author is the path's first segment. "/i/status/…" is X's anonymous form.
const STATUS_URL_RE = /^https?:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]+)\/status\/\d+/;

export function tweetAuthor(url: string): string | null {
    const handle = STATUS_URL_RE.exec(url)?.[1];
    return handle && handle !== 'i' ? handle.toLowerCase() : null;
}
