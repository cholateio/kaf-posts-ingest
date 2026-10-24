/**
 * Translation step. Finds Posts rows whose `translation` column is still
 * NULL, runs each through the translation model (Claude Haiku by default,
 * Gemini as fallback — see TRANSLATE_PROVIDER), and writes the result back to
 * the same row (single-table model — no XTranslations).
 *
 * Skip rules:
 *   - Non-Japanese text (no kana; Chinese and kanji-only titles count) → skip.
 *   - Empty / very short text             → skip; would just burn tokens.
 *
 * Per-run hard cap (`MAX_TRANSLATIONS_PER_RUN`) is the cost circuit-breaker:
 * if a backlog of hundreds of untranslated rows ever accumulates (first
 * deploy, ingest paused, etc.) the worker crawls through them at this rate
 * rather than blasting the model API with a single huge spike.
 *
 * Usage:  pnpm run translate    (or: tsx scripts/translate.ts)
 * Env:    SUPABASE_URL, SUPABASE_SERVICE_KEY, plus the key of the active provider:
 *         ANTHROPIC_API_KEY (default) or GEMINI_API_KEY when TRANSLATE_PROVIDER=gemini
 */

// Local dev: read .env. On GitHub Actions the env vars come from the
// workflow file directly, so dotenv finds nothing and is a no-op.
import 'dotenv/config';

import { pathToFileURL } from 'node:url';

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI, SchemaType, type Schema } from '@google/generative-ai';
import { stripNul } from './lib/stripNul';
import { translateInput } from './lib/translateInput';
import {
    Untranslatable,
    claudeOutputText,
    parseProvider,
    toStrictJsonSchema,
    type Provider,
} from './lib/translateProvider';

const CLAUDE_MODEL = 'claude-haiku-5-5';

// gemini-2.5-flash returned 404 "no longer available to new users" from
// 2026-07-15 onward, silently zeroing every run for 12 days. Pin the cheapest
// current tier and treat a 404 here as a model-retirement signal, not a key
// problem.
const GEMINI_MODEL = 'gemini-3.5-flash-lite';

// Drain order for the translation queue: official posts must never wait behind
// the fan feed, which outproduces them ~25:1. Each tier is a Reader tab and
// matches on seen_in membership, not the owning feed_type: a talent's tweet
// about 可不 is owned by the talent but shown in the Kafu tab, so it must be
// translated (codex review 2026-10-11). Talent tabs (rim, …) are deliberately
// absent: the Reader has none yet, so translating rows seen only there would
// only spend model tokens (decision 2026-10-10).
const FEED_PRIORITY = ['official', 'kafu', 'fan'] as const;

// USD per 1M tokens for each provider's model — update model and price together.
// Claude Haiku 5.5 has a second, 5x rate card above 100K-token prompts; these
// prompts are ~1K tokens.
const PRICES: Record<Provider, { input: number; output: number }> = {
    claude: { input: 0.1, output: 0.5 },
    gemini: { input: 0.3, output: 2.5 },
};
const API_KEY_ENV: Record<Provider, string> = {
    claude: 'ANTHROPIC_API_KEY',
    gemini: 'GEMINI_API_KEY',
};

const MAX_TRANSLATIONS_PER_RUN = 10;
const REQUEST_TIMEOUT_MS = 30_000;
// Output is ~300 tokens; the cap only has to stop a runaway response.
const CLAUDE_MAX_TOKENS = 4096;

const responseSchema: Schema = {
    type: SchemaType.OBJECT,
    properties: {
        translation: {
            type: SchemaType.STRING,
            description:
                'Traditional Chinese translation. MUST preserve the line break structure of the source — if the source has multiple lines separated by \\n, the translation must have the same number of lines separated by \\n in the corresponding positions.',
        },
        vocabulary: {
            type: SchemaType.ARRAY,
            items: {
                type: SchemaType.OBJECT,
                properties: {
                    word: { type: SchemaType.STRING },
                    reading: { type: SchemaType.STRING },
                    meaning: { type: SchemaType.STRING },
                },
                required: ['word', 'reading', 'meaning'],
            },
        },
        grammar: {
            type: SchemaType.ARRAY,
            items: {
                type: SchemaType.OBJECT,
                properties: {
                    pattern: { type: SchemaType.STRING, description: 'Grammar pattern as it appears in the text' },
                    meaning: { type: SchemaType.STRING, description: 'Explanation in Traditional Chinese' },
                },
                required: ['pattern', 'meaning'],
            },
        },
    },
    required: ['translation', 'vocabulary', 'grammar'],
};

const SYSTEM_PROMPT = `You are a Japanese-to-Traditional-Chinese translation assistant specialized in V-Singer and VTuber content.

Given a Japanese tweet, return:
1. "translation": A natural Traditional Chinese (zh-Hant) translation of the full text. CRITICAL: Preserve the line break structure of the source. If the source text contains \\n (line breaks) separating multiple lines or paragraphs, the translation MUST contain \\n in the corresponding positions so the rendered output mirrors the source's paragraph layout. Do not collapse multi-line input into a single line. Keep #hashtags and @mentions exactly as written in the source; do not translate them.
2. "vocabulary": Extract 5-8 key vocabulary words useful for a Traditional Chinese speaker learning Japanese. Each has "word" (dictionary form), "reading" (hiragana), "meaning" (Traditional Chinese). PRIORITIZE first: words with unexpected meanings (e.g. 大丈夫=沒問題), kun-yomi words (e.g. 楽しい, 嬉しい), verb conjugations (e.g. つづけてきた), words using kanji differently from Chinese (e.g. 勉強=學習), and katakana loanwords. DEPRIORITIZE (include only to reach 5, after the priority picks are exhausted): words where the kanji is identical in Chinese with the same meaning (e.g. 閉幕, 変化, 準備, 感謝) — these are obvious to Chinese readers but still useful for learners who need the Japanese reading. Aim for 5-8; only return fewer than 5 if the text genuinely lacks enough distinct words (very short tweet, mostly emoji). If the text has no parseable vocabulary (e.g., only emoji or ASCII), return an empty array.
3. "grammar": Extract 1-3 key grammar patterns from the text. Each has "pattern" (the grammar pattern as used in the text, e.g. "〜してくれて") and "meaning" (explanation in Traditional Chinese, e.g. "為我做了〜（感恩語氣）"). Focus on conjugations, particles, sentence-ending forms, and connecting patterns that help learners understand sentence structure. If the text is too simple, return an empty array.`;

// `annotated` (furigana segments) was dropped from the schema 2026-10-10:
// the Reader never rendered it (react-tweet owns the body DOM) and it was a
// large share of output tokens. The kaf_posts column itself was dropped by
// kaf-observatory migration 0009 (2026-10-14).
interface TranslationResult {
    translation: string;
    vocabulary: Array<{ word: string; reading: string; meaning: string }>;
    grammar: Array<{ pattern: string; meaning: string }>;
}

interface PostRow {
    id: string;
    external_id: string;
    original_text: string;
}
type QueuedPost = PostRow & { input: string };

interface TokenUsage {
    input: number;
    output: number;
}

type Translator = (text: string, usage: TokenUsage) => Promise<TranslationResult>;

const claudeSchema = toStrictJsonSchema(responseSchema as unknown as Record<string, unknown>);

export function claudeTranslator(apiKey: string): Translator {
    // No SDK retries: 10 rows x 30s already spend half the job's 10-minute
    // timeout in an outage, and any retry pushes past it (codex review
    // 2026-10-24). A failed row is simply picked up by the next hourly run.
    const client = new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 });
    return async (text, usage) => {
        const message = await client.messages.create({
            model: CLAUDE_MODEL,
            max_tokens: CLAUDE_MAX_TOKENS,
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: text }],
            // Short deterministic task: no thinking, lowest effort. Haiku 5.5
            // accepts disabled thinking only at effort high or below.
            thinking: { type: 'disabled' },
            output_config: { effort: 'low', format: { type: 'json_schema', schema: claudeSchema } },
        });
        usage.input += message.usage.input_tokens;
        usage.output += message.usage.output_tokens;
        return JSON.parse(claudeOutputText(message)) as TranslationResult;
    };
}

function geminiTranslator(geminiKey: string): Translator {
    return (text, usage) => callGemini(geminiKey, text, usage);
}

async function callGemini(geminiKey: string, cleanText: string, usage: TokenUsage): Promise<TranslationResult> {
    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({
        model: GEMINI_MODEL,
        generationConfig: {
            responseMimeType: 'application/json',
            responseSchema,
            // Gemini 3.x replaced thinkingConfig.thinkingBudget with
            // thinkingConfig.thinkingLevel; passing the old field is a hard 400.
            // 'minimal' is the floor — these translations are short,
            // deterministic tasks, so reasoning tokens are pure waste.
            ...({ thinkingConfig: { thinkingLevel: 'minimal' } } as Record<string, unknown>),
        },
        systemInstruction: SYSTEM_PROMPT,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await model.generateContent(
            { contents: [{ role: 'user', parts: [{ text: cleanText }] }] },
            { signal: controller.signal },
        );
        // thoughtsTokenCount bills at the output rate but is excluded from
        // candidatesTokenCount, and thinkingLevel 'minimal' does not guarantee
        // zero. Derive billed output from the total instead, so any category
        // the API adds later is still counted; fall back to candidates alone if
        // totalTokenCount is absent.
        const meta = response.response.usageMetadata;
        const prompt = meta?.promptTokenCount ?? 0;
        const candidates = meta?.candidatesTokenCount ?? 0;
        usage.input += prompt;
        usage.output += Math.max((meta?.totalTokenCount ?? 0) - prompt, candidates);
        const raw = response.response.text();
        return JSON.parse(raw) as TranslationResult;
    } finally {
        clearTimeout(timeout);
    }
}

async function main() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    const provider = parseProvider(process.env.TRANSLATE_PROVIDER);
    const apiKey = process.env[API_KEY_ENV[provider]];
    if (!url || !key || !apiKey) {
        console.error(`Missing SUPABASE_URL / SUPABASE_SERVICE_KEY / ${API_KEY_ENV[provider]}`);
        process.exit(1);
    }
    const translate = provider === 'claude' ? claudeTranslator(apiKey) : geminiTranslator(apiKey);

    const db = createClient(url, key);

    // One query per feed_type in priority order, stopping as soon as the cap is
    // filled — a lower tier only gets slots the tiers above it left unused.
    // Rows skipped by shouldSkip stay translation IS NULL forever, so each tier
    // pulls a buffer larger than the cap to keep that residue from starving it.
    const queue: QueuedPost[] = [];
    const queuedIds = new Set<string>();
    const queuedBy: string[] = [];

    for (const feedType of FEED_PRIORITY) {
        if (queue.length >= MAX_TRANSLATIONS_PER_RUN) break;

        const { data: candidates, error } = await db
            .from('kaf_posts')
            .select('id, external_id, original_text')
            .is('translation', null)
            .eq('source_type', 'x')
            .contains('seen_in', [feedType])
            .order('published_at', { ascending: false })
            .limit(MAX_TRANSLATIONS_PER_RUN * 5);

        if (error) {
            console.error(`Query failed (${feedType}):`, error.message);
            process.exit(1);
        }

        const before = queue.length;
        const nothingToTranslate: string[] = [];
        for (const post of (candidates ?? []) as PostRow[]) {
            if (queue.length >= MAX_TRANSLATIONS_PER_RUN) break;
            // A row in two tabs (official tweet about 可不) is a candidate twice.
            if (queuedIds.has(post.id)) continue;
            queuedIds.add(post.id);
            const input = translateInput(post.original_text);
            if (!input) {
                nothingToTranslate.push(post.id);
                continue;
            }
            queue.push({ ...post, input });
        }
        if (queue.length > before) queuedBy.push(`${feedType}:${queue.length - before}`);
        // Terminal state for tag-only / non-Japanese rows: translation = ''.
        // The Reader hides the panel for any falsy translation, and the row
        // leaves the newest-50 NULL window instead of crowding it until an
        // older retryable row can never be reached (codex review 2026-10-10).
        if (nothingToTranslate.length) {
            const { error: skipErr } = await db
                .from('kaf_posts')
                .update({ translation: '', vocabulary: [], grammar: [] })
                .in('id', nothingToTranslate);
            if (skipErr) console.error(`  mark not-translatable failed (${feedType}): ${skipErr.message}`);
            else console.log(`  ${feedType}: marked ${nothingToTranslate.length} rows as nothing to translate`);
        }
    }

    if (queue.length === 0) {
        console.log('Nothing to translate.');
        return;
    }

    console.log(
        `Translating ${queue.length} posts via ${provider} (capped at ${MAX_TRANSLATIONS_PER_RUN}) — ${queuedBy.join(', ')}`,
    );

    let okCount = 0;
    const usage: TokenUsage = { input: 0, output: 0 };
    for (const post of queue) {
        try {
            // Quoted bodies are already gone (translateInput); drop URLs to save tokens.
            const cleanText = post.input.replace(/https?:\/\/\S+/g, '').trim();
            const result = stripNul(await translate(cleanText, usage));
            const { error: updErr } = await db
                .from('kaf_posts')
                .update({
                    translation: result.translation,
                    vocabulary: result.vocabulary,
                    grammar: result.grammar,
                })
                .eq('id', post.id);

            if (updErr) {
                console.error(`  ${post.external_id}: UPDATE failed - ${updErr.message}`);
                continue;
            }
            okCount += 1;
            console.log(`  ${post.external_id}: ok`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // Same terminal state as tag-only rows, so a refused row stops
            // being retried every run.
            if (err instanceof Untranslatable) {
                const { error: skipErr } = await db
                    .from('kaf_posts')
                    .update({ translation: '', vocabulary: [], grammar: [] })
                    .eq('id', post.id);
                console.error(`  ${post.external_id}: UNTRANSLATABLE - ${msg}${skipErr ? ` (mark failed: ${skipErr.message})` : ''}`);
                continue;
            }
            // Per-row failure (timeout, JSON parse error, etc.) shouldn't
            // halt the batch. Logged, moved on, picked up next run.
            console.error(`  ${post.external_id}: SKIPPED - ${msg}`);
        }
    }

    const cost = (usage.input / 1e6) * PRICES[provider].input + (usage.output / 1e6) * PRICES[provider].output;
    console.log(
        `\nDone. Translated ${okCount}/${queue.length}. ` +
            `Tokens: ${usage.input} in / ${usage.output} out ≈ US$${cost.toFixed(4)}`,
    );
}

// Guarded so a scratch script can import claudeTranslator without running a batch.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
