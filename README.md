# kaf-ingest

Headless RSS + translation worker for the kaf-rss-reader Supabase backend.
Runs hourly on GitHub Actions, fetches the configured X (Twitter) RSS feeds,
inserts new posts, then runs Gemini Flash on the recent untranslated ones
and writes the translations back to the same `KAF_Posts` row.

The frontend (`virtual-desk`) only **reads** from Supabase. No Gemini key
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
npm install
npm run fetch              # pulls RSS, inserts new Posts rows
npm run translate          # translates up to 10 untranslated rows
npm run ingest             # both, in order
```

## Deploy (GitHub Actions)

1. Push this repo to GitHub (private).
2. Repo Settings → Secrets and variables → Actions → add three repository
   secrets:
    - `SUPABASE_URL`
    - `SUPABASE_SERVICE_KEY` (service-role, bypasses RLS — never expose)
    - `GEMINI_API_KEY` (recommend a separate Google AI Studio key from
      other projects so it can be revoked independently)
3. Actions tab → "Ingest" workflow → **Run workflow** to verify before
   relying on the hourly cron.

## Tuning knobs

- `scripts/translate.ts` → `MAX_TRANSLATIONS_PER_RUN` (default `10`) —
  the per-run hard cap. Backlogs drain at this rate. Raise carefully;
  the headroom protects against runaway Gemini bills if the worker ever
  finds a huge unprocessed backlog.
- `scripts/fetch.ts` → `SOURCES` array — add or remove RSS feeds here.
  All current sources are X feeds via rss.app.
- `.github/workflows/ingest.yml` → `cron` schedule. Default hourly.
