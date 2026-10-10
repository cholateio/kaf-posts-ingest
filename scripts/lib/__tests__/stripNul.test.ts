import { describe, expect, it } from 'vitest';
import { stripNul } from '../stripNul';

describe('stripNul', () => {
    it('removes U+0000 from nested strings in objects and arrays', () => {
        const input = {
            translation: '小花\u0000譜',
            annotated: [{ ruby: '花\u0000', rt: 'か' }, { text: '\u0000' }],
            vocabulary: [],
        };
        expect(stripNul(input)).toEqual({
            translation: '小花譜',
            annotated: [{ ruby: '花', rt: 'か' }, { text: '' }],
            vocabulary: [],
        });
    });
    it('leaves newlines, other text and non-string values untouched', () => {
        const input = { a: '一行\n二行', n: 3, b: true, z: null };
        expect(stripNul(input)).toEqual(input);
    });
});
