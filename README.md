# kaf-posts-ingest

Headless RSS + translation worker for the `kaf-observatory` Supabase backend.
Runs on GitHub Actions, triggered hourly by a GCP Cloud Scheduler job; fetches the configured X (Twitter) RSS feeds,
inserts new posts, then runs `gemini-3.5-flash-lite` on the untranslated ones
and writes the translations back to the same `kaf_posts` row. A third step
discovers live streams for the roster channels and upserts `kaf_streams`
(see "Streams" below).

The frontend (`kaf-observatory`, formerly `virtual-desk`) only **reads** from
Supabase. No Gemini key lives on a public web surface; rate-limit abuse
against the translate endpoint is impossible because there is no translate
endpoint.

## Schema assumption

`kaf_posts` table has these columns (run the migration in Supabase Studio
before first ingest if they don't exist yet):

```sql
ALTER TABLE kaf_posts
  ADD COLUMN translation TEXT,
  ADD COLUMN annotated   JSONB,
  ADD COLUMN vocabulary  JSONB,
  ADD COLUMN grammar     JSONB;
```

A post is considered "translated" iff `translation IS NOT NULL`. Posts that
`translate.ts` deliberately skips (non-Japanese, too short) also stay NULL
forever, so that column alone is not a backlog count.

## Feed hygiene

`SOURCES` mixes two kinds of rss.app feed, and they need different handling:

| Source | Backing URL | Clean? |
| --- | --- | --- |
| KAF Official / KAF Info | account timelines | yes |
| KAF Fan (×2) / KAFU | `x.com/search?q=…` | **no — ~10% off-topic** |
| RIM / Harusaruhi / Isekaijoucho / CIEL | talent main-account timelines | yes |

The talent feeds (`feed_type` = `rim` / `harusaruhi` / `isekaijoucho` /
`ciel`, matching the observatory roster ids) exist for the streams step:
members-only streams never appear in the public UULV playlists, so the
talents' tweets are the only discovery path. The Reader has no tab for them
and `translate.ts` does not queue them, so they cost no Gemini tokens.
Main accounts were chosen over the `*_staff` ones because they retweet the
staff announcements and add the day-of "starting soon" posts (measured on
@RIM_virtual vs @rim_staff, 2026-10-10).

X returns loosely related results for CJK search queries: terms get
token-split (`板倉可奈　永久不滅` matches 可+不, `瀧廉太郎の「花」の自筆譜`
matches 花+譜), the Top tab expands further, and account handles count as
matches (`@MatsuriCafu`). Measured against 5784 archived rows, 10% of fan and
9% of kafu entries mentioned no form of the subject at all.

Search-backed sources therefore carry a `mustMatch` regex in `SOURCES`;
entries failing it are dropped before insert and logged as
`dropped N off-topic entries`. The regex sees only the tweet body
(`tweetBody.ts` strips rss.app's trailing `— @handle date` line), otherwise
handles like `@KAFfeine_max` pass the gate. Account timelines have no gate.

The fan search is ingested through **two** rss.app feeds of the same query:
rss.app's default (X's Top tab) and one built with `f=live` (Latest). Two
snapshots on 2026-10-10 showed each feed missing posts the other carried
(10 of 28, then 6 of 31, inside the time window both covered), and the
misses never showed up in later hourly runs — so neither feed alone is
complete and swapping them would not help. Duplicates collapse on
`external_id`; the extra feed costs one rss.app slot and ~10–15 fan
translations a day against a 240/day cap.

One tweet can sit in several feeds — the fan search finds 花譜's own
tweets, and the official accounts retweet others — but `kaf_posts` keeps
one row per `external_id`. The row belongs to the most authoritative feed
that has seen it (`feedRank.ts`: official > talent accounts > kafu > fan):
when a higher feed meets a row a lower one stored first, `fetch.ts` retags
it (`retagged N rows to official`, and the `retagged` column of the job
summary). Without this, whichever feed rss.app refreshed first won, and a
new cover tweet sat in the fan tab (2026-10-10). The search feeds also
store tweets *authored* by @virtual_kaf / @kaf_info as `official` directly
(`authorFeedType` in `SOURCES`, author read from the tweet URL by
`tweetAuthor.ts`), so those never touch the fan tab even for an hour, and
survive an outage of the official feed (`N new posts (k stored as
official)` in the log). Retweets by the official accounts carry the
original author's URL, so for them the retag path is what applies.

## Translation priority

`translate.ts` fills each run's queue by `feed_type` in order —
`official` → `kafu` → `fan` — and a lower tier only gets the slots the tiers
above it left unused. The fan feed outproduces official ~25:1, so without
this, official posts would sit behind a backlog of fan chatter.

Before a row is queued, `translateInput.ts` strips rss.app's trailing
`— Name (@handle) date` line (it was 30% of input characters and came back
translated) and skips rows whose remaining text, minus links, hashtags and
mentions, is under 4 characters or has no Japanese — `#花譜 #歌ってみた`-style
posts, 82 of 1261 translations in the 30 days before 2026-10-10. Skipped
rows get `translation = ''` (the Reader hides the panel for any falsy
value) so they leave the `translation IS NULL` queue instead of crowding
its newest-50 window. Gemini
returns `translation`, `vocabulary` and `grammar`; the furigana `annotated`
field was dropped from the schema the same day (the Reader never rendered
it, and it was roughly half of the output tokens), so the column stays
null for new rows.

Each run logs its queue composition and billed token usage, e.g.
`Translating 10 posts (capped at 10) — official:8, kafu:2` and
`Done. Translated 10/10. Tokens: 4775 in / 2207 out ≈ US$0.0070`.

## Local dev

```bash
cp .env.example .env       # then fill in the four keys
pnpm install
pnpm run fetch             # pulls RSS, inserts new Posts rows
pnpm run translate         # translates up to 10 untranslated rows
pnpm run ingest            # both, in order
pnpm run streams           # live-schedule discovery, upserts kaf_streams
pnpm test                  # vitest over scripts/lib/ pure functions only
```

## Deploy (GitHub Actions)

1. Push this repo to GitHub. This one is **public** — safe because no secret
   ever lands in the tree (`.env` is gitignored, `.env.example` holds only
   placeholders, all four keys live in Actions secrets), and public repos get
   unmetered Actions minutes on standard runners.
2. Repo Settings → Secrets and variables → Actions → add four repository
   secrets:
    - `SUPABASE_URL`
    - `SUPABASE_SERVICE_KEY` (service-role, bypasses RLS — never expose)
    - `GEMINI_API_KEY` (recommend a separate Google AI Studio key from
      other projects so it can be revoked independently)
    - `YOUTUBE_API_KEY` (YouTube Data API v3 only; the streams step is
      `continue-on-error`, so a missing key degrades the schedule page but
      never fails fetch/translate)
3. Actions tab → "Ingest" workflow → **Run workflow** to verify before
   relying on the trigger.

### Trigger

The workflow has no `schedule:` trigger. GCP Cloud Scheduler (project
`kaf-obs`, job `kaf-posts-ingest-hourly`, `15 * * * *`) POSTs
`/repos/cholateio/kaf-posts-ingest/actions/workflows/ingest.yml/dispatches`
with body `{"ref":"main"}` and a fine-grained PAT (this repo only,
Actions: read/write) in the `Authorization` header.

Why not GitHub's own cron: it fired best-effort (7-16 runs/day in July,
4-6 by late September, never 24), and GitHub auto-disables
schedule-bearing workflows after 60 days without a push. A disabled
workflow also rejects `workflow_dispatch` (HTTP 422), so keeping
`schedule:` "as a backup" would eventually take the Scheduler trigger
down with it. That happened 2026-10-01..09.

If runs stop: check the Scheduler job's status in the GCP console first
(401 = PAT revoked or wrong, 422 = workflow disabled), then
`gh api repos/cholateio/kaf-posts-ingest/actions/workflows --jq '.workflows[].state'`.

A green run does not prove the worker works: per-row failures are caught
and never change the exit code (12 days of `Translated 0/10` hid behind
success badges in July 2026). Health is the log, not the badge — it
should show `Total new posts`, `Translated N/N` with N > 0 whenever a
backlog exists, and `new=… refreshed=…` from the streams step. Only the
latest run's log comes back from `gh run view <id> --log`; for older runs it
prints nothing, so fetch the zip instead:
`gh api repos/cholateio/kaf-posts-ingest/actions/runs/<id>/logs > l.zip`.

The fetch step also raises a `Feed health` annotation (shown on the run
page) when a feed fails, returns 0 entries, has a newest entry older than
its `maxQuietHours`, or loses more than half its entries to `mustMatch`;
the job summary carries a per-feed table (entries / dropped / new / newest).

Throughput math, measured over 79 days of archived rows (post-gate):
**67 translatable posts/day on average, single-day peak 148**, against a
capacity of 10 per run × 24 runs/day = **240/day** (was ~120/day under
GitHub's cron). Average demand fits with room; a peak day drains within the
same day.

## Tuning knobs

- `scripts/translate.ts` → `MAX_TRANSLATIONS_PER_RUN` (default `10`) —
  the per-run hard cap, and the billing circuit-breaker. At the default and
  24 runs/day it ceils the Gemini bill at ~US$13/month; raising it (or the
  Scheduler frequency) raises that ceiling proportionally. Actual spend
  tracks post volume, not the ceiling.
- `scripts/translate.ts` → `GEMINI_MODEL` plus `PRICE_PER_M_INPUT` /
  `PRICE_PER_M_OUTPUT` — change together, or the logged cost silently lies.
  A `404 no longer available` from this model means Google retired it, not
  that the key broke (happened 2026-07-15; see `docs/LESSONS.md`).
- `scripts/translate.ts` → `FEED_PRIORITY` — the drain order described above.
- `scripts/fetch.ts` → `SOURCES` array — add or remove RSS feeds here.
  All current sources are X feeds via rss.app. Anything search-backed needs
  a `mustMatch` regex; account timelines do not. Every source needs a
  `maxQuietHours` — set it above the longest gap the feed has shown between
  posts, or the health check warns on normal quiet spells.
- Run frequency → the Cloud Scheduler job's cron in GCP (`kaf-obs`), not
  the workflow file. See "Trigger" above.

## Streams (live schedule)

`pnpm run streams` (`scripts/streams.ts`) feeds the `kaf_streams` table behind
`kaf-observatory`'s `/schedule` page. Each run:

1. reads every roster channel's `UULV` (live) and `UULF` (long-form uploads)
   playlists — RSS first (keyless), falling back to `playlistItems.list`
   (1 quota unit) because GitHub runners get 404/500 from the RSS endpoints
   (observed 2026-10-09, IP-based);
2. scans the `TWEET_FEEDS` rss.app feeds (@virtual_kaf, @kaf_info plus the
   talent main accounts, same feeds as `fetch.ts`) for YouTube links
   (`extractVideoIds`, full 11-char ids only); `members_only` comes from the
   text following each link (メンバーシップ限定 / メン限 / membership) or
   from the video title — the Data API has no such flag;
3. looks up new ids plus stale `upcoming`/`live` rows (≤50, older than 30 min)
   with one `videos.list` call per 50 ids (1 quota unit each);
4. keeps a video on an off-roster channel only when a tweet linked it **and**
   it is a live/premiere (`assembleRows.ts`) — a guest appearance on another
   VTuber's channel. Retweeted MVs and covers on other channels are dropped.
   Non-YouTube appearances (NHK radio, TV, niconico) are out of scope here;
5. upserts on `video_id`. Nothing is written to `kaf_posts`.

It runs as the last step of `ingest.yml` with `continue-on-error: true`, so
a YouTube quota or key problem shows up as a yellow step, not a red run.
Row shape (`StreamRow` in `scripts/lib/youtube.ts`): `video_id`,
`channel_id`, `title`, `scheduled_start`, `actual_start`, `actual_end`,
`published_at`, `status` (`upcoming` / `live` / `ended` / `published` / `unavailable`), `is_premiere`,
`members_only`, `discovered_via`, `hashtags`, `updated_at`.

The channel list `STREAM_CHANNEL_IDS` must stay in sync with
`kaf-observatory/src/lib/schedule/roster.ts` — see "Adding a talent" below
for what each side's drift costs. Needs `YOUTUBE_API_KEY` (GitHub secret
+ local `.env`), restricted to YouTube Data API v3 on the Google Cloud side.

## Adding a talent

A talent is defined by their YouTube channels; the X feed is optional. The
channel list lives in **two repos** with nothing checking they agree, so do
all steps in one sitting.

1. **Collect the channel ids** (`UC…`): the main (music) channel and the
   stream / membership channel if separate (e.g. 理芽 → RIM + STRANGE GIRL
   CLUB). Verify each id before use:
   `curl -s "https://www.youtube.com/feeds/videos.xml?channel_id=UC…" | grep -m1 '<title>'`
   must print the expected channel name.
2. **This repo** — append the ids to `STREAM_CHANNEL_IDS` in
   `scripts/streams.ts`, with a `// name role` comment.
3. **kaf-observatory** — add an entry to `TALENTS` in
   `src/lib/schedule/roster.ts`: `id` (short ascii, becomes the
   `feed_type` below), `name`, `shortName`, `color`, `aliases` (used to spot
   the talent in other channels' titles and hashtags), and `channels` with
   `role: "music" | "stream"`. A unit / project channel with no single owner
   goes in `GROUP_CHANNELS` instead.
4. **Optional, for members-only streams** — create an rss.app feed of the
   talent's **main** X account (not `*_staff` / `*_info`; reasoning in
   "Feed hygiene"), then add it to `SOURCES` in `scripts/fetch.ts`
   (`feedType` = the roster `id`, `maxQuietHours: TIMELINE_QUIET_H`, extend
   the `feedType` union) and to `TWEET_FEEDS` in `scripts/streams.ts`. Do
   not add the new type to `FEED_PRIORITY` in `translate.ts` until the
   Reader has a tab for it.
5. **Verify**: run `pnpm run streams` (or dispatch the workflow) and check
   the talent's rows appear in `kaf_streams`; then load `/schedule` and
   confirm the cards carry the talent's name and colour.

What a half-done addition looks like:

| Done | Missing | Effect |
| --- | --- | --- |
| roster.ts | streams.ts | Public live streams appear (the web scans UULV itself every 10 min); tweet-found members-only streams never do. |
| streams.ts | roster.ts | Rows reach the DB but render as host-less `OFFICIAL` cards — no name, no colour, cannot be muted — and only after the hourly ingest, since the web does not scan those channels. |
| channels | X feed | Everything except members-only streams. |

Budgets: rss.app Basic allows 15 feeds (9 in use as of 2026-10-10).
YouTube Data API quota is 10,000 units/day per key; each channel costs this
worker ~48/day (UULV + UULF via `playlistItems.list`, since GitHub runners
are blocked from the RSS endpoint) and the observatory ~144/day (UULV every
10 min), plus at most one `videos.list` unit per refresh on each side.
13 channels put the worst case at roughly 3,300 units/day.
