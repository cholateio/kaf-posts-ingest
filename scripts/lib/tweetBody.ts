// rss.app X feeds end every item with an attribution line,
// "— @handle Oct 10, 2026" (or "— Name (@handle) Oct 10, 2026"). It is not
// part of the tweet: translation must not see it (translateInput.ts).
const ATTRIBUTION_RE = /\s*—\s*(?:[^\n]*?\(@[A-Za-z0-9_]+\)|@[A-Za-z0-9_]+)\s+[A-Z][a-z]{2} \d{1,2}, \d{4}\s*$/;

export function tweetBody(text: string): string {
    return text.replace(ATTRIBUTION_RE, '');
}
