import { tweetBody } from './tweetBody';

// Hiragana, katakana, or CJK kanji. If none of these appear, the text is
// almost certainly not Japanese (English RT, pure-emoji post, etc.) and
// translation is a waste of tokens.
const JAPANESE_RE = /[぀-ゟ゠-ヿ一-鿿]/;
const MIN_CORE_CHARS = 4;

// What is left once links, hashtags, mentions, whitespace, punctuation and
// symbols are gone — the part Gemini would actually translate.
function core(text: string): string {
    return text
        .replace(/https?:\/\/\S+/g, '')
        .replace(/[#＃][\p{L}\p{N}_]+/gu, '') // X ends a hashtag at punctuation, not whitespace
        .replace(/@[A-Za-z0-9_]+/g, '')
        .replace(/[\s\p{P}\p{S}]/gu, '');
}

/**
 * The text to send to Gemini for a kaf_posts row, or null when the row is
 * not worth a call: rss.app's trailing "— Name (@handle) date" line is
 * removed (it was 30% of translated input and came back translated, 2026-10-10),
 * and tag/link-only posts such as "#花譜 #歌ってみた" are skipped (82 of 1261
 * translations in the preceding 30 days). Quoted-tweet bodies are removed
 * as well; what comes back is exactly what Gemini receives.
 */
export function translateInput(originalText: string): string | null {
    const own = stripQuotedContent(tweetBody(originalText).trim()).trim();
    const c = core(own);
    if (c.length < MIN_CORE_CHARS || !JAPANESE_RE.test(c)) return null;
    return own;
}

/**
 * Strip the inlined quoted body from quote-tweet input before translation.
 *
 * rss.app inlines quoted tweets without any structural delimiter — they
 * just concatenate <originalText><QuotedDisplayName> (@<quotedHandle>)
 * <quotedBody>—  https://x.com/<quotedHandle>/status/<id>. The trailing
 * `/status/` URL is unique to quote tweets (the per-post attribution line
 * `— Name (@handle) date` has no path), so it doubles as a reliable
 * detector. RT-style retweets carry no /status/ URL in body and are
 * intentionally left intact — the user wants those translated in full.
 *
 * Only Gemini input is filtered; original_text in the DB stays untouched
 * so the frontend's existing quote-hide / jump-to-source UI keeps working.
 * Applied before the eligibility check too, so a quote tweet whose own
 * commentary is a bare hashtag is skipped even when the quoted body is
 * Japanese (codex review 2026-10-10).
 */
export function stripQuotedContent(text: string): string {
    const quoteUrlRe = /—\s+https?:\/\/x\.com\/(\w+)\/status\/\d+/;
    const match = quoteUrlRe.exec(text);
    if (!match) return text;

    const handle = match[1];
    const handleMarker = `(@${handle})`;
    const handlePos = text.indexOf(handleMarker);
    if (handlePos === -1) return text;

    // Walk back ≤30 chars to nearest \n or sentence-end glyph to also strip
    // the display name preceding (@handle); rss.app gives no explicit
    // delimiter so a bounded heuristic is the best signal we have.
    let cutPos = handlePos;
    for (let i = handlePos - 1; i >= 0 && handlePos - i < 30; i--) {
        const ch = text[i];
        if (ch === '\n' || /[。！？!?⟡♡♥]/.test(ch)) {
            cutPos = i + 1;
            break;
        }
    }

    return text.substring(0, cutPos).trimEnd();
}

