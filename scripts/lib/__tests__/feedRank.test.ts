import { describe, expect, it } from 'vitest';
import { memberships, ownerOf, membershipPatches } from '../feedRank';

const row = (id: string, feed_type: string, seen_in: string[]) => ({ external_id: id, feed_type, seen_in });

describe('memberships', () => {
    it("a timeline feed adds itself and the author's own feed (talent retweets an official tweet)", () => {
        expect(memberships('rim', 'virtual_kaf', false)).toEqual(['rim', 'official']);
        expect(memberships('official', 'rim_virtual', false)).toEqual(['official', 'rim']);
    });
    it('a timeline feed with its own author is just itself', () => {
        expect(memberships('rim', 'rim_virtual', false)).toEqual(['rim']);
        expect(memberships('official', 'kaf_info', false)).toEqual(['official']);
    });
    it('a fans-only search feed files a known author under that account only, never fan', () => {
        expect(memberships('fan', 'rim_virtual', true)).toEqual(['rim']);
        expect(memberships('fan', 'virtual_kaf', true)).toEqual(['official']);
        expect(memberships('fan', 'someone_else', true)).toEqual(['fan']);
    });
    it('the topical kafu search keeps kafu and adds the known author (CIEL tweeting about 可不)', () => {
        expect(memberships('kafu', 'ciel_vanillasky', false)).toEqual(['kafu', 'ciel']);
        expect(memberships('kafu', 'virtual_kaf', false)).toEqual(['kafu', 'official']);
        expect(memberships('kafu', 'someone_else', false)).toEqual(['kafu']);
    });
    it('an anonymous /i/status URL (author null) adds nothing beyond the source', () => {
        expect(memberships('fan', null, true)).toEqual(['fan']);
        expect(memberships('rim', null, false)).toEqual(['rim']);
    });
    it('handles are matched lowercase (tweetAuthor lowercases; KNOWN_AUTHORS keys must too)', () => {
        expect(memberships('fan', 'ciel_vanillasky', true)).toEqual(['ciel']);
        expect(memberships('fan', 'isekaijoucho', true)).toEqual(['isekaijoucho']);
        expect(memberships('fan', 'harusaruhi', true)).toEqual(['harusaruhi']);
    });
});

describe('ownerOf', () => {
    it('picks the highest-ranked type: official > talent > kafu > fan', () => {
        expect(ownerOf(['rim', 'official'])).toBe('official');
        expect(ownerOf(['fan', 'kafu'])).toBe('kafu');
        expect(ownerOf(['harusaruhi', 'rim'])).toBe('harusaruhi'); // tie: first wins
    });
});

describe('membershipPatches', () => {
    it('appends the new memberships and retags the owner when outranked (official claims a fan row)', () => {
        expect(membershipPatches(['official'], [row('a', 'fan', ['fan'])])).toEqual([
            { ids: ['a'], patch: { feed_type: 'official', seen_in: ['fan', 'official'] } },
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
        expect(membershipPatches(['fan'], [row('a', 'official', ['official', 'fan']), row('b', 'fan', ['fan'])])).toEqual([]);
    });
    it('groups rows that end up with the same patch into one update', () => {
        expect(membershipPatches(['official'], [row('a', 'fan', ['fan']), row('b', 'fan', ['fan']), row('c', 'kafu', ['kafu'])])).toEqual([
            { ids: ['a', 'b'], patch: { feed_type: 'official', seen_in: ['fan', 'official'] } },
            { ids: ['c'], patch: { feed_type: 'official', seen_in: ['kafu', 'official'] } },
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
