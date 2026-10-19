import { describe, expect, it } from 'vitest';
import { feedUrl, parseFeeds, redactFeedUrls } from '../feeds';

describe('feedUrl', () => {
    const env = { RSS_FEEDS: '{"kafu":"abcDEF123","rim":"x_y"}' };
    it('builds the rss.app URL for a known key', () => {
        expect(feedUrl('kafu', env)).toBe('https://rss.app/feeds/abcDEF123.xml');
    });
    it('fails loudly for an unknown key instead of skipping the feed', () => {
        expect(() => feedUrl('ciel', env)).toThrow('no entry for "ciel"');
    });
    it('fails loudly when RSS_FEEDS is missing or empty', () => {
        expect(() => feedUrl('kafu', {})).toThrow('RSS_FEEDS is not set');
        expect(() => feedUrl('kafu', { RSS_FEEDS: '  ' })).toThrow('RSS_FEEDS is not set');
    });
});

describe('parseFeeds', () => {
    it('rejects malformed values', () => {
        expect(() => parseFeeds('not json')).toThrow('not valid JSON');
        expect(() => parseFeeds('["a"]')).toThrow('must be a JSON object');
        expect(() => parseFeeds('{"k":"https://rss.app/feeds/x.xml"}')).toThrow('not an rss.app feed id');
        expect(() => parseFeeds('{"k":7}')).toThrow('not an rss.app feed id');
    });
});

describe('redactFeedUrls', () => {
    it('hides every feed id in a log line', () => {
        expect(redactFeedUrls('GET https://rss.app/feeds/abc123.xml failed; https://rss.app/feeds/x_y.xml')).toBe(
            'GET https://rss.app/feeds/***.xml failed; https://rss.app/feeds/***.xml',
        );
    });
});
