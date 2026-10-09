import { describe, expect, it } from 'vitest';
import { extractVideoIds } from '../videoIds';

// Verbatim shapes observed in the rss.app feed for @kaf_info on 2026-10-09.
const TWEET = `
【お知らせ📢】花譜メンバーシップ生配信
https://youtube.com/live/ZXGfT8oX22I ※無料配信
後半 https://www.youtube.com/live/hg7jeGt2Zh4?si=abc123 ※メンバーシップ限定配信
MV: https://youtu.be/D7QtTBWGH78
old: https://www.youtube.com/watch?v=4JYCkE-X9iw&t=42s
short: https://youtube.com/shorts/y1LZn5k4Tso
channel: https://www.youtube.com/channel/UCkJYa9mVS25eHOO9bM7YK3Q/join
truncated: youtube.com/live/hg7jeGt2Z…
`;

describe('extractVideoIds', () => {
    it('extracts every supported URL form, deduped and in order', () => {
        expect(extractVideoIds(TWEET)).toEqual([
            'ZXGfT8oX22I', 'hg7jeGt2Zh4', 'D7QtTBWGH78', '4JYCkE-X9iw', 'y1LZn5k4Tso',
        ]);
    });
    it('ignores channel URLs and truncated ids', () => {
        expect(extractVideoIds('youtube.com/live/hg7jeGt2Z… https://www.youtube.com/channel/UCkJYa9mVS25eHOO9bM7YK3Q')).toEqual([]);
    });
    it('does not swallow a trailing character into the id', () => {
        // 12th char must terminate the match, not extend it.
        expect(extractVideoIds('https://youtu.be/D7QtTBWGH78x')).toEqual([]);
    });
    it('returns [] for text without links', () => {
        expect(extractVideoIds('前半配信、ご視聴いただきありがとうございました!!')).toEqual([]);
    });
});
