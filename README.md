# kaf-ingest

Headless RSS + translation worker for the kaf-rss-reader Supabase backend.
Runs on a GitHub Actions cron, fetches the configured X (Twitter) RSS feeds,
inserts new posts, then runs Gemini Flash on the recent untranslated ones
and writes the translations back to the same `KAF_Posts` row.

The frontend (`kaf-observatory`, formerly `virtual-desk`) only **reads** from
Supabase. No Gemini key
lives on a public web surface; rate-limit abuse against the translate
endpoint is impossible because there is no translate endpoint.

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

A post is considered "translated" iff `translation IS NOT NULL`.

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
Post volume (≤2/hr) and the ≤10 translations/run cap mean this still keeps
up, so the schedule is left as-is — but do not treat "hourly" as a guarantee.
An external cron hitting `workflow_dispatch` is the fix if punctuality ever
matters.

## Tuning knobs

- `scripts/translate.ts` → `MAX_TRANSLATIONS_PER_RUN` (default `10`) —
  the per-run hard cap. Backlogs drain at this rate. Raise carefully;
  the headroom protects against runaway Gemini bills if the worker ever
  finds a huge unprocessed backlog.
- `scripts/fetch.ts` → `SOURCES` array — add or remove RSS feeds here.
  All current sources are X feeds via rss.app.
- `.github/workflows/ingest.yml` → `cron` schedule. Set to hourly; see
  "Actual cron cadence" above for what GitHub really delivers.
