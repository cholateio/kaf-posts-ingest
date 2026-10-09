// YouTube video ids are exactly 11 chars of [A-Za-z0-9_-]. rss.app renders
// the *display* text truncated ("hg7jeGt2Z…") but the href keeps the full
// URL, so matching full URLs with a hard 11-char boundary drops truncations
// instead of producing a wrong id.
const VIDEO_URL =
    /(?:youtube\.com\/(?:live|shorts|embed)\/|youtu\.be\/|youtube\.com\/watch\?(?:[^\s&]*&)*v=)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/g;

export function extractVideoIds(text: string): string[] {
    const out: string[] = [];
    for (const m of text.matchAll(VIDEO_URL)) {
        if (!out.includes(m[1])) out.push(m[1]);
    }
    return out;
}
