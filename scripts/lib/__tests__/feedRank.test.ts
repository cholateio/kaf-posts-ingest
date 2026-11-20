import { describe, expect, it } from 'vitest';
import { memberships, ownerOf, membershipPatches } from '../feedRank';

const row = (id: string, feed_type: string, seen_in: string[]) => ({ external_id: id, feed_type, seen_in });

describe('memberships', () => {
    it("a timeline feed adds itself and the author's own feed (talent retweets an official tweet)", () => {
        expect(memberships('rim', 'virtual_kaf')).toEqual(['rim', 'official']);
        expect(memberships('official', 'rim_virtual')).toEqual(['official', 'rim']);
    });
    it('a timeline feed with its own author is just itself', () => {
        expect(memberships('rim', 'rim_virtual')).toEqual(['rim']);
        expect(memberships('official', 'kaf_info')).toEqual(['official']);
    });
    it('an anonymous /i/status URL (author null) adds nothing beyond the source', () => {
        expect(memberships('rim', null)).toEqual(['rim']);
    });
    it('handles are matched lowercase (tweetAuthor lowercases; KNOWN_AUTHORS keys must too)', () => {
        expect(memberships('official', 'ciel_vanillasky')).toEqual(['official', 'ciel']);
        expect(memberships('official', 'isekaijoucho')).toEqual(['official', 'isekaijoucho']);
        expect(memberships('official', 'harusaruhi')).toEqual(['official', 'harusaruhi']);
        expect(memberships('official', 'koko__virtual')).toEqual(['official', 'koko']);
        expect(memberships('official', 'asu_virtual')).toEqual(['official', 'asu']);
    });
    it('a talent retweeting 幸祜 puts the row in both talent feeds', () => {
        expect(memberships('rim', 'koko__virtual')).toEqual(['rim', 'koko']);
    });
});

describe('ownerOf', () => {
    it('picks the highest-ranked type: official > talent', () => {
        expect(ownerOf(['rim', 'official'])).toBe('official');
        expect(ownerOf(['harusaruhi', 'rim'])).toBe('harusaruhi'); // tie: first wins
    });
});

describe('membershipPatches', () => {
    it('appends the new memberships and retags the owner when outranked (official claims a talent row)', () => {
        expect(membershipPatches(['official'], [row('a', 'rim', ['rim'])])).toEqual([
            { ids: ['a'], patch: { feed_type: 'official', seen_in: ['rim', 'official'] } },
        ]);
    });
    it('appends without retag when not outranked (talent feed sees an official-owned row)', () => {
        expect(membershipPatches(['rim'], [row('a', 'official', ['official'])])).toEqual([
            { ids: ['a'], patch: { seen_in: ['official', 'rim'] } },
        ]);
    });
    it('two talents retweeting one tweet: both in seen_in, first owner kept', () => {
        expect(membershipPatches(['harusaruhi'], [row('a', 'rim', ['rim'])])).toEqual([
            { ids: ['a'], patch: { seen_in: ['rim', 'harusaruhi'] } },
        ]);
    });
    it('skips rows that already carry every membership', () => {
        expect(membershipPatches(['rim'], [row('a', 'official', ['official', 'rim']), row('b', 'rim', ['rim'])])).toEqual([]);
    });
    it('groups rows that end up with the same patch into one update', () => {
        expect(membershipPatches(['official'], [row('a', 'rim', ['rim']), row('b', 'rim', ['rim']), row('c', 'koko', ['koko'])])).toEqual([
            { ids: ['a', 'b'], patch: { feed_type: 'official', seen_in: ['rim', 'official'] } },
            { ids: ['c'], patch: { feed_type: 'official', seen_in: ['koko', 'official'] } },
        ]);
    });
    it('a legacy feed_type it does not rank keeps its owner but still gains membership', () => {
        expect(membershipPatches(['official'], [row('a', 'legacy_yt', ['legacy_yt'])])).toEqual([
            { ids: ['a'], patch: { seen_in: ['legacy_yt', 'official'] } },
        ]);
    });
    it('a multi-type membership set (talent retweet of official) retags to the top type', () => {
        expect(membershipPatches(['rim', 'official'], [row('a', 'rim', ['rim'])])).toEqual([
            { ids: ['a'], patch: { feed_type: 'official', seen_in: ['rim', 'official'] } },
        ]);
    });
});
