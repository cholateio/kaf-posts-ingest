import { describe, expect, it } from 'vitest';
import { Untranslatable, claudeOutputText, parseProvider, toStrictJsonSchema } from '../translateProvider';

describe('parseProvider', () => {
    it('defaults to claude when unset or empty (unset Actions variable)', () => {
        expect(parseProvider(undefined)).toBe('claude');
        expect(parseProvider('')).toBe('claude');
        expect(parseProvider('  ')).toBe('claude');
    });
    it('accepts known providers case-insensitively', () => {
        expect(parseProvider('gemini')).toBe('gemini');
        expect(parseProvider(' Claude ')).toBe('claude');
    });
    it('rejects anything else instead of silently picking one', () => {
        expect(() => parseProvider('openai')).toThrow(/TRANSLATE_PROVIDER/);
    });
});

describe('claudeOutputText', () => {
    it('returns the text block, skipping thinking blocks before it', () => {
        const msg = {
            stop_reason: 'end_turn',
            content: [{ type: 'thinking' }, { type: 'text', text: '{"translation":"x"}' }],
        };
        expect(claudeOutputText(msg)).toBe('{"translation":"x"}');
    });
    it('throws Untranslatable on refusal, with the category', () => {
        const msg = { stop_reason: 'refusal', stop_details: { category: 'general_harms' }, content: [] };
        expect(() => claudeOutputText(msg)).toThrow(Untranslatable);
        expect(() => claudeOutputText(msg)).toThrow(/general_harms/);
    });
    it('throws a plain (retryable) error on truncation or missing text', () => {
        const truncated = { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"transl' }] };
        expect(() => claudeOutputText(truncated)).toThrow(/max_tokens/);
        expect(() => claudeOutputText(truncated)).not.toThrow(Untranslatable);
        expect(() => claudeOutputText({ stop_reason: 'end_turn', content: [] })).toThrow(/no text block/);
    });
});

describe('toStrictJsonSchema', () => {
    it('closes every object, including ones nested in arrays, and keeps other fields', () => {
        const schema = {
            type: 'object',
            properties: {
                t: { type: 'string', description: 'd' },
                list: { type: 'array', items: { type: 'object', properties: { w: { type: 'string' } }, required: ['w'] } },
            },
            required: ['t', 'list'],
        };
        expect(toStrictJsonSchema(schema)).toEqual({
            type: 'object',
            additionalProperties: false,
            properties: {
                t: { type: 'string', description: 'd' },
                list: {
                    type: 'array',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: { w: { type: 'string' } },
                        required: ['w'],
                    },
                },
            },
            required: ['t', 'list'],
        });
    });
    it('does not mutate its input', () => {
        const schema = { type: 'object', properties: {} };
        toStrictJsonSchema(schema);
        expect(schema).toEqual({ type: 'object', properties: {} });
    });
});
