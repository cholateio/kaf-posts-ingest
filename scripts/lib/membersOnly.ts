import { extractVideoIds } from './videoIds';

// Spec verification point 2: the Data API exposes no members-only flag, so
// the tweet text and the video title are the only signals. "MEMBERSHIP ONLY"
// observed verbatim in a members-only stream title (hg7jeGt2Zh4, 2026-10-09).
export const MEMBERS_ONLY_RE = /メンバーシップ限定|メン限|membership|members?[- ]?only/i;

const VIDEO_URL_SPLIT = /(https?:\/\/[^\s]*(?:youtube\.com|youtu\.be)\/[^\s]*)/;

// One tweet often announces a free part and a members-only part with one
// link each (observed 2026-10-09), so a tweet-wide match would flag the free
// stream too. With several links the hint is read from the text that follows
// each link up to the next one; with a single link the whole tweet counts.
export function tweetMembersOnlyHints(text: string): Map<string, boolean> {
    const out = new Map<string, boolean>();
    const ids = extractVideoIds(text);
    if (ids.length === 0) return out;
    if (ids.length === 1) {
        out.set(ids[0], MEMBERS_ONLY_RE.test(text));
        return out;
    }
    const parts = text.split(VIDEO_URL_SPLIT);
    for (let i = 1; i < parts.length; i += 2) {
        const [id] = extractVideoIds(parts[i]);
        if (!id) continue;
        const trailing = parts[i + 1] ?? '';
        out.set(id, (out.get(id) ?? false) || MEMBERS_ONLY_RE.test(trailing));
    }
    return out;
}
