import { describe, expect, it } from 'vitest';
import { MEMBERS_ONLY_RE, tweetMembersOnlyHints } from '../membersOnly';

// Real @kaf_info tweet shape (2026-10-09): one tweet announces the free first
// half and the members-only second half with a different link each.
const TWO_LINK_TWEET = `【お知らせ📢】花譜メンバーシップ生配信
前半 https://youtube.com/live/ZXGfT8oX22I ※無料配信
後半 https://www.youtube.com/live/hg7jeGt2Zh4?si=abc ※メンバーシップ限定配信`;

describe('tweetMembersOnlyHints', () => {
    it('attributes the hint to the link it annotates, not to every link in the tweet', () => {
        expect(tweetMembersOnlyHints(TWO_LINK_TWEET)).toEqual(new Map([
            ['ZXGfT8oX22I', false],
            ['hg7jeGt2Zh4', true],
        ]));
    });
    it('single-link tweet: the whole text counts', () => {
        expect(tweetMembersOnlyHints('メン限で雑談します！ https://youtu.be/D7QtTBWGH78')).toEqual(new Map([['D7QtTBWGH78', true]]));
    });
    it('no links → empty map', () => {
        expect(tweetMembersOnlyHints('メンバーシップ限定配信ありがとう')).toEqual(new Map());
    });
});

describe('MEMBERS_ONLY_RE', () => {
    it('matches the title forms seen in the wild', () => {
        expect(MEMBERS_ONLY_RE.test('【描くよっ】新しいメンシバッジ【MEMBERSHIP ONLY】')).toBe(true);
        expect(MEMBERS_ONLY_RE.test('メン限雑談')).toBe(true);
        expect(MEMBERS_ONLY_RE.test('【なんの秋？】ライブ振り返り')).toBe(false);
    });
});
