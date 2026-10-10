import { describe, expect, it } from 'vitest';
import { tweetAuthor } from '../tweetAuthor';

describe('tweetAuthor', () => {
    it('reads the lowercase handle from an x.com status URL', () => {
        expect(tweetAuthor('https://x.com/virtual_kaf/status/2108844996548083747')).toBe('virtual_kaf');
        expect(tweetAuthor('https://x.com/KAF_info/status/1')).toBe('kaf_info');
        expect(tweetAuthor('https://twitter.com/nhk_vtuberradio/status/1?s=20')).toBe('nhk_vtuberradio');
    });
    it('returns null for anything else', () => {
        expect(tweetAuthor('https://x.com/i/status/1')).toBeNull();
        expect(tweetAuthor('b9d67ed5eaeabc2775ba7af9f3a7cb99')).toBeNull();
        expect(tweetAuthor('')).toBeNull();
    });
});
