import { describe, expect, it } from 'vitest';
import { tweetBody } from '../tweetBody';

describe('tweetBody', () => {
    it('drops the "— @handle date" attribution line', () => {
        expect(tweetBody('たけのこの里の80個入り、とんでもねぇ量\n\n— @KAFfeine_max Oct 10, 2026')).toBe('たけのこの里の80個入り、とんでもねぇ量');
    });
    it('drops the "— Name (@handle) date" form', () => {
        expect(tweetBody('本日19時から\n\n— 花譜-KAF- (@virtual_kaf) Oct 9, 2026')).toBe('本日19時から');
    });
    it('keeps the body untouched, including handles and dashes inside it', () => {
        const body = '@virtual_kaf 花譜ちゃん最高 — ほんとに\n#花譜';
        expect(tweetBody(`${body}\n\n— @fan Oct 10, 2026`)).toBe(body);
        expect(tweetBody(body)).toBe(body);
    });
});
