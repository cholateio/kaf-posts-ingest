/**
 * Translation step. Finds Posts rows whose `translation` column is still
 * NULL, runs each through Gemini Flash, and writes the result back to the
 * same row (single-table model — no XTranslations).
 *
 * Skip rules:
 *   - Non-Japanese text (no kana / kanji) → skip; nothing useful to translate.
 *   - Empty / very short text             → skip; would just burn tokens.
 *
 * Per-run hard cap (`MAX_TRANSLATIONS_PER_RUN`) is the cost circuit-breaker:
 * if a backlog of hundreds of untranslated rows ever accumulates (first
 * deploy, ingest paused, etc.) the worker crawls through them at this rate
 * rather than blasting Gemini with a single huge spike.
 *
 * Usage:  pnpm run translate    (or: tsx scripts/translate.ts)
 * Env:    SUPABASE_URL, SUPABASE_SERVICE_KEY, GEMINI_API_KEY
 */

// Local dev: read .env. On GitHub Actions the env vars come from the
// workflow file directly, so dotenv finds nothing and is a no-op.
import 'dotenv/config';

import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI, SchemaType, type Schema } from '@google/generative-ai';
import { stripNul } from './lib/stripNul';
import { translateInput } from './lib/translateInput';

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
// only spend Gemini tokens (decision 2026-10-10).
const FEED_PRIORITY = ['official', 'kafu', 'fan'] as const;

// Paid-tier USD per 1M tokens for GEMINI_MODEL — update both together.
const PRICE_PER_M_INPUT = 0.3;
const PRICE_PER_M_OUTPUT = 2.5;

const MAX_TRANSLATIONS_PER_RUN = 10;
const GEMINI_TIMEOUT_MS = 30_000;

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
1. "translation": A natural Traditional Chinese (zh-Hant) translation of the full text. CRITICAL: Preserve the line break structure of the source. If the source text contains \\n (line breaks) separating multiple lines or paragraphs, the translation MUST contain \\n in the corresponding positions so the rendered output mirrors the source's paragraph layout. Do not collapse multi-line input into a single line.
2. "vocabulary": Extract 5-8 key vocabulary words useful for a Traditional Chinese speaker learning Japanese. Each has "word" (dictionary form), "reading" (hiragana), "meaning" (Traditional Chinese). PRIORITIZE first: words with unexpected meanings (e.g. 大丈夫=沒問題), kun-yomi words (e.g. 楽しい, 嬉しい), verb conjugations (e.g. つづけてきた), words using kanji differently from Chinese (e.g. 勉強=學習), and katakana loanwords. DEPRIORITIZE (include only to reach 5, after the priority picks are exhausted): words where the kanji is identical in Chinese with the same meaning (e.g. 閉幕, 変化, 準備, 感謝) — these are obvious to Chinese readers but still useful for learners who need the Japanese reading. Aim for 5-8; only return fewer than 5 if the text genuinely lacks enough distinct words (very short tweet, mostly emoji). If the text has no parseable vocabulary (e.g., only emoji or ASCII), return an empty array.
3. "grammar": Extract 1-3 key grammar patterns from the text. Each has "pattern" (the grammar pattern as used in the text, e.g. "〜してくれて") and "meaning" (explanation in Traditional Chinese, e.g. "為我做了〜（感恩語氣）"). Focus on conjugations, particles, sentence-ending forms, and connecting patterns that help learners understand sentence structure. If the text is too simple, return an empty array.`;

// `annotated` (furigana segments) was dropped from the schema 2026-10-10:
// the Reader never rendered it (react-tweet owns the body DOM) and it was a
// large share of output tokens. The kaf_posts column stays, null from now on.
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

async function callGemini(geminiKey: string, text: string, usage: TokenUsage): Promise<TranslationResult> {
    // Quoted bodies are already gone (translateInput); drop URLs to save tokens.
    const cleanText = text.replace(/https?:\/\/\S+/g, '').trim();

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
    const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
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
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!url || !key || !geminiKey) {
        console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY / GEMINI_API_KEY');
        process.exit(1);
    }

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
        `Translating ${queue.length} posts (capped at ${MAX_TRANSLATIONS_PER_RUN}) — ${queuedBy.join(', ')}`,
    );

    let okCount = 0;
    const usage: TokenUsage = { input: 0, output: 0 };
    for (const post of queue) {
        try {
            const result = stripNul(await callGemini(geminiKey, post.input, usage));
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
            // Per-row failure (Gemini timeout, JSON parse error, etc.) shouldn't
            // halt the batch. Logged, moved on, picked up next run.
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`  ${post.external_id}: SKIPPED - ${msg}`);
        }
    }

    const cost = (usage.input / 1e6) * PRICE_PER_M_INPUT + (usage.output / 1e6) * PRICE_PER_M_OUTPUT;
    console.log(
        `\nDone. Translated ${okCount}/${queue.length}. ` +
            `Tokens: ${usage.input} in / ${usage.output} out ≈ US$${cost.toFixed(4)}`,
    );
}

main();
