# kaf-posts-ingest

Headless RSS + translation worker for the `kaf-observatory` Supabase backend.
Runs on a GitHub Actions cron, fetches the configured X (Twitter) RSS feeds,
inserts new posts, then runs `gemini-3.5-flash-lite` on the untranslated ones
and writes the translations back to the same `KAF_Posts` row.

The frontend (`kaf-observatory`, formerly `virtual-desk`) only **reads** from
Supabase. No Gemini key lives on a public web surface; rate-limit abuse
against the translate endpoint is impossible because there is no translate
endpoint.

## Schema assumption

`KAF_Posts` table has these columns (run the migration in Supabase Studio
before first ingest if they don't exist yet):

```sql
ALTER TABLE "KAF_Posts"
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
cp .env.example .env       # then fill in the three keys
pnpm install
pnpm run fetch             # pulls RSS, inserts new Posts rows
pnpm run translate         # translates up to 10 untranslated rows
pnpm run ingest            # both, in order
```

## Deploy (GitHub Actions)

1. Push this repo to GitHub. This one is **public** — safe because no secret
   ever lands in the tree (`.env` is gitignored, `.env.example` holds only
   placeholders, all three keys live in Actions secrets), and public repos get
   unmetered Actions minutes on standard runners.
2. Repo Settings → Secrets and variables → Actions → add three repository
   secrets:
    - `SUPABASE_URL`
    - `SUPABASE_SERVICE_KEY` (service-role, bypasses RLS — never expose)
    - `GEMINI_API_KEY` (recommend a separate Google AI Studio key from
      other projects so it can be revoked independently)
3. Actions tab → "Ingest" workflow → **Run workflow** to verify before
   relying on the cron.

### Actual cron cadence

The schedule asks for hourly, but GitHub runs scheduled workflows on a
best-effort basis and silently drops them under load. Measured over
2026-07-04..07-13 the workflow actually fired **7-16 times a day, never 24**.
Do not treat "hourly" as a guarantee; an external cron hitting
`workflow_dispatch` is the fix if punctuality ever matters.

Throughput math, measured over 79 days of archived rows (post-gate):
**67 translatable posts/day on average, single-day peak 148**, against a
capacity of 10 per run × ~12 runs/day = **120/day**. Average demand fits;
peak days overflow and drain over the following days. That is the origin of
any small standing backlog — not a bug.

## Tuning knobs

- `scripts/translate.ts` → `MAX_TRANSLATIONS_PER_RUN` (default `10`) —
  the per-run hard cap, and the billing circuit-breaker. At the default it
  ceils the Gemini bill at ~US$6.5/month; raising it raises that ceiling
  proportionally.
- `scripts/translate.ts` → `GEMINI_MODEL` plus `PRICE_PER_M_INPUT` /
  `PRICE_PER_M_OUTPUT` — change together, or the logged cost silently lies.
  A `404 no longer available` from this model means Google retired it, not
  that the key broke (happened 2026-07-15; see `docs/LESSONS.md`).
- `scripts/translate.ts` → `FEED_PRIORITY` — the drain order described above.
- `scripts/fetch.ts` → `SOURCES` array — add or remove RSS feeds here.
  All current sources are X feeds via rss.app. Anything search-backed needs
  a `mustMatch` regex; account timelines do not.
- `.github/workflows/ingest.yml` → `cron` schedule. Set to hourly; see
  "Actual cron cadence" above for what GitHub really delivers.
