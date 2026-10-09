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
| KAF Fan / KAFU | `x.com/search?q=…` | **no — ~10% off-topic** |

X returns loosely related results for CJK search queries: terms get
token-split (`板倉可奈　永久不滅` matches 可+不, `瀧廉太郎の「花」の自筆譜`
matches 花+譜), the Top tab expands further, and account handles count as
matches (`@MatsuriCafu`). Measured against 5784 archived rows, 10% of fan and
9% of kafu entries mentioned no form of the subject at all.

Search-backed sources therefore carry a `mustMatch` regex in `SOURCES`;
entries failing it are dropped before insert and logged as
`dropped N off-topic entries`. Account timelines have no gate.

## Translation priority

`translate.ts` fills each run's queue by `feed_type` in order —
`official` → `kafu` → `fan` — and a lower tier only gets the slots the tiers
above it left unused. The fan feed outproduces official ~25:1, so without
this, official posts would sit behind a backlog of fan chatter.

Each run logs its queue composition and billed token usage, e.g.
`Translating 10 posts (capped at 10) — official:8, kafu:2` and
`Done. Translated 10/10. Tokens: 5892 in / 4399 out ≈ US$0.0128`.

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
success badges in July 2026). Health is the log, not the badge —
`gh run view <id> --log | grep -E 'Done\.|Translating'` should show
`Total new posts`, `Translated N/N` with N > 0 whenever a backlog exists,
and `new=… refreshed=…` from the streams step.

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
  a `mustMatch` regex; account timelines do not.
- Run frequency → the Cloud Scheduler job's cron in GCP (`kaf-obs`), not
  the workflow file. See "Trigger" above.

## Streams (live schedule)

`pnpm run streams` (`scripts/streams.ts`) feeds the `kaf_streams` table behind
`kaf-observatory`'s `/schedule` page. Each run:

1. reads every roster channel's `UULV` (live) and `UULF` (long-form uploads)
   playlists — RSS first (keyless), falling back to `playlistItems.list`
   (1 quota unit) because GitHub runners get 404/500 from the RSS endpoints
   (observed 2026-10-09, IP-based);
2. scans the `TWEET_FEEDS` rss.app feeds for YouTube links (`extractVideoIds`,
   full 11-char ids only); `members_only` comes from the text following each
   link (メンバーシップ限定 / メン限 / membership) or from the video title —
   the Data API has no such flag;
3. looks up new ids plus stale `upcoming`/`live` rows (≤50, older than 30 min)
   with one `videos.list` call per 50 ids (1 quota unit each);
4. upserts on `video_id`. Nothing is written to `kaf_posts`.

It runs as the last step of `ingest.yml` with `continue-on-error: true`, so
a YouTube quota or key problem shows up as a yellow step, not a red run.
Row shape (`StreamRow` in `scripts/lib/youtube.ts`): `video_id`,
`channel_id`, `title`, `scheduled_start`, `actual_start`, `actual_end`,
`published_at`, `status` (`upcoming` / `live` / `ended` / `published` / `unavailable`), `is_premiere`,
`members_only`, `discovered_via`, `hashtags`, `updated_at`.

The channel list `STREAM_CHANNEL_IDS` must stay in sync with
`kaf-observatory/src/lib/schedule/roster.ts`; drift only costs
tweet-discovered members-only streams. Needs `YOUTUBE_API_KEY` (GitHub secret
+ local `.env`), restricted to YouTube Data API v3 on the Google Cloud side.
