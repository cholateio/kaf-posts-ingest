// Translation backend switch. Claude is the default since 2026-10-24; Gemini
// stays wired as the fallback so switching back is a repo variable
// (TRANSLATE_PROVIDER=gemini), not a code change.
export const PROVIDERS = ['claude', 'gemini'] as const;
export type Provider = (typeof PROVIDERS)[number];

export function parseProvider(raw: string | undefined): Provider {
    const value = (raw ?? '').trim().toLowerCase();
    // An unset Actions variable expands to '' — that means "default".
    if (value === '') return 'claude';
    if ((PROVIDERS as readonly string[]).includes(value)) return value as Provider;
    throw new Error(`TRANSLATE_PROVIDER must be one of ${PROVIDERS.join(' / ')}, got "${raw}"`);
}

/**
 * The model declined the input for good (safety classifier). Retrying the
 * same text every hour only burns quota — a Gemini PROHIBITED_CONTENT row did
 * exactly that (review 2026-10-10) — so the caller marks the row terminal.
 */
export class Untranslatable extends Error {}

interface ClaudeMessageLike {
    stop_reason: string | null;
    stop_details?: { category?: string | null } | null;
    content: ReadonlyArray<{ type: string; text?: string }>;
}

/** The JSON text of a structured-output response, or a throw explaining why there is none. */
export function claudeOutputText(message: ClaudeMessageLike): string {
    if (message.stop_reason === 'refusal') {
        throw new Untranslatable(`refused (${message.stop_details?.category ?? 'no category'})`);
    }
    // A truncated structured output is unparseable JSON; say so instead of
    // surfacing a confusing JSON.parse error.
    if (message.stop_reason === 'max_tokens') throw new Error('output truncated at max_tokens');
    const text = message.content.find((block) => block.type === 'text')?.text;
    if (!text) throw new Error(`no text block (stop_reason=${message.stop_reason})`);
    return text;
}

type JsonSchemaNode = { [key: string]: unknown };

/**
 * Claude structured outputs require `additionalProperties: false` on every
 * object; Gemini's schema dialect has no such field. Deriving one from the
 * other keeps a single schema source for both providers.
 */
export function toStrictJsonSchema(node: JsonSchemaNode): JsonSchemaNode {
    const out: JsonSchemaNode = { ...node };
    if (node.type === 'object') {
        out.additionalProperties = false;
        if (node.properties && typeof node.properties === 'object') {
            out.properties = Object.fromEntries(
                Object.entries(node.properties as Record<string, JsonSchemaNode>).map(([k, v]) => [
                    k,
                    toStrictJsonSchema(v),
                ]),
            );
        }
    }
    if (node.type === 'array' && node.items && typeof node.items === 'object') {
        out.items = toStrictJsonSchema(node.items as JsonSchemaNode);
    }
    return out;
}
