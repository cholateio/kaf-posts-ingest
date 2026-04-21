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
 * Usage:  npm run translate    (or: tsx scripts/translate.ts)
 * Env:    SUPABASE_URL, SUPABASE_SERVICE_KEY, GEMINI_API_KEY
 */

// Local dev: read .env. On GitHub Actions the env vars come from the
// workflow file directly, so dotenv finds nothing and is a no-op.
import 'dotenv/config';

import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI, SchemaType, type Schema } from '@google/generative-ai';

const MAX_TRANSLATIONS_PER_RUN = 10;
const MIN_TEXT_LENGTH = 4;
const GEMINI_TIMEOUT_MS = 30_000;

// Hiragana, katakana, or CJK kanji. If none of these appear, the text is
// almost certainly not Japanese (English RT, pure-emoji post, etc.) and
// translation is a waste of tokens.
const JAPANESE_RE = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/;

const responseSchema: Schema = {
    type: SchemaType.OBJECT,
    properties: {
        translation: {
            type: SchemaType.STRING,
            description:
                'Traditional Chinese translation. MUST preserve the line break structure of the source — if the source has multiple lines separated by \\n, the translation must have the same number of lines separated by \\n in the corresponding positions.',
        },
        annotated: {
            type: SchemaType.ARRAY,
            items: {
                type: SchemaType.OBJECT,
                properties: {
                    ruby: { type: SchemaType.STRING, description: 'Kanji text' },
                    rt: { type: SchemaType.STRING, description: 'Furigana reading' },
                    text: { type: SchemaType.STRING, description: 'Non-kanji text segment' },
                },
            },
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
    required: ['translation', 'annotated', 'vocabulary', 'grammar'],
};

const SYSTEM_PROMPT = `You are a Japanese-to-Traditional-Chinese translation assistant specialized in V-Singer and VTuber content.

Given a Japanese tweet, return:
1. "translation": A natural Traditional Chinese (zh-Hant) translation of the full text. CRITICAL: Preserve the line break structure of the source. If the source text contains \\n (line breaks) separating multiple lines or paragraphs, the translation MUST contain \\n in the corresponding positions so the rendered output mirrors the source's paragraph layout. Do not collapse multi-line input into a single line.
2. "annotated": Break the original Japanese text into sequential segments. For segments containing kanji, provide "ruby" (the kanji text) and "rt" (the furigana reading). For segments without kanji (hiragana, katakana, punctuation, emoji, spaces), provide "text" with the literal characters. The concatenation of all ruby/text values must exactly reconstruct the original text.
3. "vocabulary": Extract 5-8 key vocabulary words useful for a Traditional Chinese speaker learning Japanese. Each has "word" (dictionary form), "reading" (hiragana), "meaning" (Traditional Chinese). PRIORITIZE first: words with unexpected meanings (e.g. 大丈夫=沒問題), kun-yomi words (e.g. 楽しい, 嬉しい), verb conjugations (e.g. つづけてきた), words using kanji differently from Chinese (e.g. 勉強=學習), and katakana loanwords. DEPRIORITIZE (include only to reach 5, after the priority picks are exhausted): words where the kanji is identical in Chinese with the same meaning (e.g. 閉幕, 変化, 準備, 感謝) — these are obvious to Chinese readers but still useful for learners who need the Japanese reading. Aim for 5-8; only return fewer than 5 if the text genuinely lacks enough distinct words (very short tweet, mostly emoji). If the text has no parseable vocabulary (e.g., only emoji or ASCII), return an empty array.
4. "grammar": Extract 1-3 key grammar patterns from the text. Each has "pattern" (the grammar pattern as used in the text, e.g. "〜してくれて") and "meaning" (explanation in Traditional Chinese, e.g. "為我做了〜（感恩語氣）"). Focus on conjugations, particles, sentence-ending forms, and connecting patterns that help learners understand sentence structure. If the text is too simple, return an empty array.`;

interface TranslationResult {
    translation: string;
    annotated: Array<{ ruby?: string; rt?: string; text?: string }>;
    vocabulary: Array<{ word: string; reading: string; meaning: string }>;
    grammar: Array<{ pattern: string; meaning: string }>;
}

interface PostRow {
    id: string;
    external_id: string;
    original_text: string;
}

function shouldSkip(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed.length < MIN_TEXT_LENGTH) return true;
    if (!JAPANESE_RE.test(trimmed)) return true;
    return false;
}

async function callGemini(geminiKey: string, text: string): Promise<TranslationResult> {
    // Strip URLs before sending — they add noise and use up tokens. The greedy
    // `\S+` boundary is fine here because we control the input shape.
    const cleanText = text.replace(/https?:\/\/\S+/g, '').trim();

    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({
        model: 'gemini-2.5-flash',
        generationConfig: {
            responseMimeType: 'application/json',
            responseSchema,
            // Disable thinking budget — these translations are short, deterministic
            // tasks; reasoning tokens just waste latency and cost.
            ...({ thinkingConfig: { thinkingBudget: 0 } } as Record<string, unknown>),
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

    // Newest-first so we always cover what users are most likely to look at,
    // even when there's a backlog. Pull a buffer larger than the cap so the
    // skip-filter (non-Japanese / too short) doesn't starve the run.
    const { data: candidates, error } = await db
        .from('KAF_Posts')
        .select('id, external_id, original_text')
        .is('translation', null)
        .eq('source_type', 'x')
        .order('published_at', { ascending: false })
        .limit(MAX_TRANSLATIONS_PER_RUN * 5);

    if (error) {
        console.error('Query failed:', error.message);
        process.exit(1);
    }
    if (!candidates || candidates.length === 0) {
        console.log('Nothing to translate.');
        return;
    }

    const queue: PostRow[] = [];
    for (const post of candidates as PostRow[]) {
        if (queue.length >= MAX_TRANSLATIONS_PER_RUN) break;
        if (shouldSkip(post.original_text)) continue;
        queue.push(post);
    }

    if (queue.length === 0) {
        console.log(`No translatable posts in top ${candidates.length} candidates.`);
        return;
    }

    console.log(`Translating ${queue.length} posts (capped at ${MAX_TRANSLATIONS_PER_RUN})...`);

    let okCount = 0;
    for (const post of queue) {
        try {
            const result = await callGemini(geminiKey, post.original_text);
            const { error: updErr } = await db
                .from('KAF_Posts')
                .update({
                    translation: result.translation,
                    annotated: result.annotated,
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

    console.log(`\nDone. Translated ${okCount}/${queue.length}.`);
}

main();
