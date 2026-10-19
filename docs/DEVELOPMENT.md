# Development

## Commands

```bash
cp .env.example .env       # then fill in the keys and RSS_FEEDS
pnpm install
pnpm run fetch             # pull RSS, insert new kaf_posts rows
pnpm run translate         # translate up to 10 untranslated rows
pnpm run ingest            # fetch then translate
pnpm run streams           # live-schedule discovery, upserts kaf_streams
pnpm test                  # vitest over the pure functions in scripts/lib/
```

`fetch` and `translate` are verified by running them and reading the output; only `scripts/lib/` has unit tests.

## Environment variables

Locally from `.env` (gitignored, template in `.env.example`); in CI from repository Actions secrets.

`RSS_FEEDS` holds the rss.app feed ids as a JSON object (`{"kafu": "<id>", ...}`). The ids are paid capabilities, so the code names feeds only by key (`feedUrl('kafu')` in `scripts/lib/feeds.ts`); a missing key fails the run instead of silently skipping a feed.

- `SUPABASE_URL`: Supabase project URL.
- `SUPABASE_SERVICE_KEY`: service-role key. Bypasses RLS; never expose it on a web surface.
- `GEMINI_API_KEY`: Google AI Studio key. Use a key dedicated to this worker so it can be revoked on its own.
- `YOUTUBE_API_KEY`: Google Cloud API key restricted to YouTube Data API v3. Used only by the streams step, which is `continue-on-error`, so a missing key degrades the schedule but never fails fetch/translate.

## Schema notes

`kaf_posts` needs `translation TEXT`, `vocabulary JSONB` and `grammar JSONB` in addition to the post columns:

```sql
ALTER TABLE kaf_posts
  ADD COLUMN translation TEXT,
  ADD COLUMN vocabulary  JSONB,
  ADD COLUMN grammar     JSONB;
```

A row is "translated" iff `translation IS NOT NULL`. Rows `translate.ts` decides not to translate (no kana, or under 4 core characters once links, hashtags and mentions are removed) get `translation = ''`, so they leave the `IS NULL` queue instead of crowding its newest-50 window; the front end hides the panel for any falsy value. The column alone is therefore not a backlog count.

The furigana `annotated` field was removed from the Gemini schema (never rendered, roughly half of output tokens) and the column was dropped.

Retention: only tweets published from 2026-10-01 00:00 Taiwan time are kept. `scripts/lib/retention.ts` holds that floor (checked against both the snowflake ID and `publishedAt`) so `fetch.ts` never re-inserts older tweets that the feeds still list.

## Trigger

`ingest.yml` has only `workflow_dispatch`. An external scheduler (Google Cloud Scheduler, cron `15 * * * *`) POSTs `/repos/<owner>/kaf-posts-ingest/actions/workflows/ingest.yml/dispatches` with body `{"ref":"main"}` and a fine-grained PAT (this repo only, Actions: read/write) in the `Authorization` header. Overlapping runs queue rather than cancel (`concurrency: ingest`).

Do not add `schedule:` back, not even as a backup. GitHub's cron fired best-effort (7–16 runs/day in July 2026, 4–6 by late September, never 24), and GitHub auto-disables schedule-bearing workflows after 60 days without a push. A disabled workflow also rejects `workflow_dispatch` (HTTP 422), which takes the external trigger down with it. That happened 2026-10-01..09.

If runs stop: check the scheduler job's last status first (401 = PAT revoked or wrong, 422 = workflow disabled), then `gh api repos/<owner>/kaf-posts-ingest/actions/workflows --jq '.workflows[].state'`.

## Health is the log, not the badge

Per-row failures are caught and never change the exit code (12 days of `Translated 0/10` hid behind green badges in July 2026). A healthy log shows `Total new posts`, `Translated N/N` with N > 0 whenever a backlog exists, and `new=… refreshed=…` from the streams step.

The fetch step raises a `Feed health` annotation when a feed fails, returns 0 entries, has a newest entry older than its `maxQuietHours`, or loses more than half its entries to `mustMatch`. The job summary carries a per-feed table (entries / dropped / new / retagged / joined / newest / warnings).

`gh run view <id> --log` returns only the latest run's log; for older runs fetch the zip with `gh api repos/<owner>/kaf-posts-ingest/actions/runs/<id>/logs > l.zip`.

Throughput, measured over 79 days of archived rows (after the relevance gate): 67 translatable posts/day on average, single-day peak 148, against a capacity of 10 per run × 24 runs/day = 240/day.

## Feed hygiene

`SOURCES` in `scripts/fetch.ts` mixes account timelines (clean) and rss.app wrappers around `x.com/search?q=…` (about 10% off-topic). X loosely matches CJK search terms: they get token-split (`板倉可奈　永久不滅` matches 可+不, `瀧廉太郎の「花」の自筆譜` matches 花+譜), the Top tab expands further, and account handles count as matches. Measured against 5784 archived rows, 10% of fan and 9% of kafu entries mentioned no form of the subject.

- Search-backed sources carry a `mustMatch` regex; failures are dropped before insert and logged as `dropped N off-topic entries`. The regex sees only the tweet body (`tweetBody.ts` strips rss.app's trailing `— @handle date` line), otherwise any handle containing `kaf` passes. Account timelines have no gate.
- Every source needs a `maxQuietHours` above the longest gap the feed has shown between posts, or the health check warns on normal quiet spells.
- The fan search is ingested through two rss.app feeds of the same query: the default (Top) and one built with `f=live` (Latest). Snapshots on 2026-10-10 showed each missing posts the other carried (10 of 28, then 6 of 31), and the misses never arrived later. Latest is the backbone; if one must go, drop Top. Duplicates collapse on `external_id`.
- Talent feeds use the talents' main X accounts, not the `*_staff` ones: main accounts retweet staff announcements and add the day-of "starting soon" posts (measured on @RIM_virtual vs @rim_staff, 2026-10-10). They exist for the streams step, because members-only streams never appear in the public live playlists. `translate.ts` does not queue them.

### One row per tweet

A tweet can sit in several feeds, but `kaf_posts` keeps one row per `external_id`. `seen_in` lists every feed that saw it (front-end tabs filter on containment), and `feed_type` is the single owner used for translation priority: the highest rank in `feedRank.ts` (official > talent accounts > kafu > fan). When a higher feed meets a row a lower one stored first, `fetch.ts` updates `seen_in` and, if the owner changes, `feed_type` (logged per feed, and the `retagged` / `joined` columns of the job summary).

Search feeds marked `fansOnly` store tweets authored by a known account (`KNOWN_AUTHORS` in `feedRank.ts`, author read from the tweet URL by `tweetAuthor.ts`) under that account only, never as `fan`. Retweets carry the original author's URL, so for them the membership path applies. `KNOWN_AUTHORS` must stay in sync with the account feeds in `SOURCES` and with the front end's retweet handling.

## Translation

`translate.ts` fills each run's queue by tier in `FEED_PRIORITY` order (`official` → `kafu` → `fan`, matched on `seen_in`); a lower tier only gets slots the tiers above left unused. The fan feed outproduces official about 25:1. Talent tiers are absent until the front end has tabs for them; do not add a new type to `FEED_PRIORITY` before that.

Before queueing, `translateInput.ts` strips rss.app's trailing `— Name (@handle) date` line (it was 30% of input characters and came back translated) and inlined quoted-tweet bodies. Kanji alone does not count as Japanese: Chinese fan posts passed a kanji test and came back translated into Japanese (2026-10-11).

Each run logs its queue composition and token usage, e.g. `Translating 10 posts (capped at 10) — official:8, kafu:2`.

## Tuning knobs

- `scripts/translate.ts` → `MAX_TRANSLATIONS_PER_RUN` (default `10`): the per-run hard cap and the circuit-breaker on Gemini usage. Raising it, or the scheduler frequency, raises the ceiling proportionally.
- `scripts/translate.ts` → `GEMINI_MODEL` together with the per-token price constants beside it; change them together or the logged estimate is wrong. A `404 no longer available` means Google retired the model, not that the key broke (happened 2026-07-15).
- `scripts/translate.ts` → `FEED_PRIORITY`: the drain order above.
- `scripts/fetch.ts` → `SOURCES`: add or remove feeds (add the new key and id to the `RSS_FEEDS` secret and your `.env` first). Search-backed feeds need `mustMatch`; every feed needs `maxQuietHours`.
- Run frequency lives in the external scheduler, not in the workflow file.

## Streams (live schedule)

`scripts/streams.ts` feeds `kaf_streams`. Each run:

1. reads every channel in `STREAM_CHANNEL_IDS`: its live (`UULV`) and long-form uploads (`UULF`) playlists, RSS first (keyless), falling back to `playlistItems.list` (1 quota unit) because GitHub runners get 404/500 from the RSS endpoints (observed 2026-10-09, IP-based);
2. scans the `TWEET_FEEDS` (official and talent accounts, same rss.app feeds as `fetch.ts`) for YouTube links (`extractVideoIds`, full 11-char IDs only). `members_only` comes from the text after each link (メンバーシップ限定 / メン限 / membership) or the video title; the Data API has no such flag;
3. looks up new IDs plus stale `upcoming`/`live` rows (up to 50, older than 30 minutes) with one `videos.list` call per 50 IDs (1 quota unit each);
4. keeps a video on an off-roster channel only when a tweet linked it and it is a live stream or premiere (`assembleRows.ts`): a guest appearance. Retweeted MVs and covers on other channels are dropped. Non-YouTube appearances are out of scope;
5. upserts on `video_id`. Nothing is written to `kaf_posts` (fan or search feeds here would turn every linked stream into an event).

Row shape is `StreamRow` in `scripts/lib/youtube.ts`; `status` is one of `upcoming` / `live` / `ended` / `published` / `unavailable`.

## Adding a talent

A talent is defined by YouTube channels; the X feed is optional. The channel list lives in two places (this repo and the front end's roster) with nothing checking they agree, so do all steps in one sitting.

1. Collect the channel IDs (`UC…`): the main (music) channel and the stream/membership channel if separate. Verify each: `curl -s "https://www.youtube.com/feeds/videos.xml?channel_id=UC…" | grep -m1 '<title>'` must print the expected channel name.
2. Append the IDs to `STREAM_CHANNEL_IDS` in `scripts/streams.ts` with a `// name role` comment.
3. Add the talent to the front end's roster. Its short ASCII `id` becomes the `feed_type` below.
4. Optional, for members-only streams: create an rss.app feed of the talent's main X account, add it to `SOURCES` in `scripts/fetch.ts` (`feedType` = the roster `id`, `maxQuietHours: TIMELINE_QUIET_H`, extend the `FeedType` union and `RANK` / `KNOWN_AUTHORS` in `feedRank.ts`) and to `TWEET_FEEDS` in `scripts/streams.ts`.
5. Verify: run `pnpm run streams` (or dispatch the workflow), check the talent's rows in `kaf_streams`, then check the schedule page shows the talent's name and colour.

What a half-done addition looks like:

| Done | Missing | Effect |
| --- | --- | --- |
| front-end roster | `streams.ts` | Public live streams appear (the front end scans live playlists itself); tweet-found members-only streams never do. |
| `streams.ts` | front-end roster | Rows reach the DB but render as host-less cards (no name, no colour, cannot be muted), and only after the hourly ingest. |
| channels | X feed | Everything except members-only streams. |

Budgets: rss.app plans cap the number of feeds; count the feeds in `SOURCES` before adding one. YouTube Data API quota is 10,000 units/day per key. Each channel uses about 48 units/day in this worker (live + uploads via `playlistItems.list`) and about 144/day in the front end (live playlist every 10 minutes), plus at most one `videos.list` unit per refresh on each side. With 26 channels the worst case is roughly 5,700 units/day, leaving room for about 20 more before the front end needs a longer cache window.
