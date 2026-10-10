import { describe, expect, it } from 'vitest';
import { idsToRetag } from '../feedRank';

const row = (id: string, feed_type: string) => ({ external_id: id, feed_type });

describe('idsToRetag', () => {
    it('official claims rows a search feed stored first (fan snapshot raced the official refresh)', () => {
        expect(idsToRetag('official', [row('a', 'fan'), row('b', 'kafu'), row('c', 'official')])).toEqual(['a', 'b']);
    });
    it('a talent feed claims fan/kafu rows but never an official one', () => {
        expect(idsToRetag('rim', [row('a', 'fan'), row('b', 'kafu'), row('c', 'official')])).toEqual(['a', 'b']);
    });
    it('talent feeds do not take rows from each other', () => {
        expect(idsToRetag('rim', [row('a', 'harusaruhi'), row('b', 'rim')])).toEqual([]);
    });
    it('kafu claims fan rows; fan claims nothing', () => {
        expect(idsToRetag('kafu', [row('a', 'fan'), row('b', 'kafu')])).toEqual(['a']);
        expect(idsToRetag('fan', [row('a', 'kafu'), row('b', 'official'), row('c', 'rim')])).toEqual([]);
    });
    it('leaves a stored feed_type it does not know alone', () => {
        expect(idsToRetag('official', [row('a', 'legacy_yt')])).toEqual([]);
    });
});
