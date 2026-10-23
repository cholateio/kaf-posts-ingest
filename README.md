# kaf-posts-ingest

**English** | [繁體中文](README.zh-TW.md)

You follow the virtual singer KAF (花譜) and the KAMITSUBAKI talents, and want their X posts translated and their YouTube streams on one schedule. Once an hour a GitHub Actions run pulls the X feeds, translates new Japanese posts into Traditional Chinese with vocabulary and grammar notes, and writes posts and stream times into your own Supabase project.

```
$ tsx scripts/fetch.ts
  KAF Official: 0 new (25 already exist)
  KAF Fan #KAF (latest): dropped 3 off-topic entries
  KAF Fan #KAF (latest): 9 new posts
  KAFU #KAFU: dropped 6 off-topic entries
  …
Done. Total new posts: 9
$ tsx scripts/translate.ts
  fan: marked 3 rows as nothing to translate
Translating 10 posts (capped at 10) — fan:10
  …
$ tsx scripts/streams.ts
  rss blocked for 52 playlists; used playlistItems.list (52 quota units)
Discovered 602 video ids
Nothing new or stale. Done.
```

- **Translations for learners**: each Japanese post gets a Traditional Chinese translation that keeps its line breaks, 5–8 vocabulary words with readings, and 1–3 grammar patterns, stored as JSON next to the original text.
- **Off-topic filter**: posts from the X search feeds must mention the subject in the tweet body or they are dropped, and posts with no kana or under 4 characters of real text are marked as nothing to translate.
- **One row per tweet**: a tweet seen in several feeds is stored once and filed under the most authoritative one (official, then talent accounts, then the 可不 search, then the fan search), and official posts are translated first, 10 per run.
- **Stream schedule**: each roster channel's live and uploads playlists, plus YouTube links in official and talent tweets, are looked up on the YouTube Data API and saved with status, start and end times, and premiere and members-only flags.

Input and output for one feed:

```ts
// scripts/fetch.ts → SOURCES
{ name: 'KAFU #KAFU', feedType: 'kafu', rssUrl: feedUrl('kafu'), mustMatch: /可不|kafu/i, maxQuietHours: 72 }
```

```
kaf_posts    external_id, feed_type, seen_in, original_text, media_urls, published_at,
             translation, vocabulary [{word, reading, meaning}], grammar [{pattern, meaning}]
kaf_streams  video_id, channel_id, title, scheduled_start, actual_start, status,
             is_premiere, members_only, discovered_via, hashtags
```

The feeds, channel list and filters are written for KAF and the KAMITSUBAKI roster, and the table definitions are not in this repo, so your own copy needs your own feeds, channels and tables.

## How it works

```
your scheduler, hourly ──► GitHub Actions "Ingest" (workflow_dispatch)
   fetch      rss.app X feeds ──► relevance filter ──► kaf_posts
   translate  untranslated rows ──► Gemini ──► translation, vocabulary, grammar
   streams    YouTube playlists + tweet links ──► YouTube Data API ──► kaf_streams
```

There is no server and no public endpoint. The worker only writes to Supabase; a front end only needs to read from it.

## Install

You need a GitHub account, a Supabase project, a Google AI Studio API key for Gemini, a Google Cloud API key limited to YouTube Data API v3, [rss.app](https://rss.app) feeds for the X accounts and searches you follow, and something that can send an HTTP request every hour.

1. Fork the repo.
2. In Supabase, create the `kaf_posts` and `kaf_streams` tables with the columns above, plus `id` and `source_type` on `kaf_posts`. `external_id` and `video_id` must be unique, `seen_in` is a text array, and `vocabulary` and `grammar` are `jsonb`. The exact writes are in `scripts/fetch.ts`, `scripts/translate.ts` and `StreamRow` in `scripts/lib/youtube.ts`.
3. Edit the sources: feed keys in `SOURCES` (`scripts/fetch.ts`) and `TWEET_FEEDS`, channel IDs in `STREAM_CHANNEL_IDS` (`scripts/streams.ts`), and the cutoff date in `scripts/lib/retention.ts`, which ignores tweets published before 1 October 2026.
4. In your fork, open **Settings → Secrets and variables → Actions → New repository secret** and add five secrets: `SUPABASE_URL` with your project URL, `SUPABASE_SERVICE_KEY` with the service-role key, `GEMINI_API_KEY`, `YOUTUBE_API_KEY`, and `RSS_FEEDS` with a JSON object mapping each feed key used in `scripts/fetch.ts` to its rss.app feed id, for example `{"kafu":"<id>"}`.
5. Open **Actions → Ingest → Run workflow** and read the log of the first run.
6. Have your scheduler send `POST https://api.github.com/repos/<you>/kaf-posts-ingest/actions/workflows/ingest.yml/dispatches` with the body `{"ref":"main"}` every hour, authorised by a fine-grained token limited to this repo with **Actions: Read and write**. The workflow has no built-in schedule.

A green run does not prove posts were translated, because one failed post never fails the job. Check the log and the **Feed health** warnings on the run page.

## Privacy & security

- All keys, and the rss.app feed ids (`RSS_FEEDS`, a JSON object of feed key to id), live in GitHub Actions secrets, or in a gitignored `.env` for local runs. None are committed.
- The service-role key bypasses row-level security. The worker needs it to write; never put it in a front end.
- Post text, without links and the trailing author line, is sent to Google's Gemini API. Video IDs are sent to the YouTube Data API.
- Only public posts and public video details are stored: text, media URLs, translations, and stream titles and times.
- The workflow's GitHub token can only read this repo; all writes go to Supabase.

## License

[MIT](LICENSE).
