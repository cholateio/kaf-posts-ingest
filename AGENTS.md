# kaf-posts-ingest

## Project goal

RSS 抓取 + 翻譯 worker：每小時抓 KAF（花譜）相關 X/Twitter 帳號的 rss.app
RSS feed，寫入 Supabase `kaf_posts` 表，再用 Gemini 翻譯未翻譯的貼文
（日→繁中，含單字/文法欄位；注音 `annotated` 已於 2026-10-10 停產、2026-10-14 刪欄；10/1 前的貼文已刪，`retention.ts` 擋回流）回寫同一列。前端消費者是
**kaf-observatory**（舊名 virtual-desk）的 Reader overlay——唯讀 `kaf_posts`。

## Stack

- Language: TypeScript 5.8 / Node 22（tsx 直跑 .ts，無編譯步驟，`noEmit: true`）
- 外部服務: Supabase（`@supabase/supabase-js`）、Google Gemini
  `gemini-3.5-flash-lite`（`@google/generative-ai`；2.5 系列 2026-07 已被 Google 下架）、rss.app（feed 供應方）
- 部署: GitHub Actions 執行，由外部排程器（Cloud Scheduler，每小時）以 fine-grained PAT 呼叫
  workflow_dispatch API 觸發；secrets 走 Actions。`ingest.yml` 只有 `workflow_dispatch`，
  **不要加回 `schedule:`**——理由見該檔註解與 `docs/DEVELOPMENT.md`「Trigger」
- 套件管理: pnpm（`packageManager` 欄位鎖 pnpm@11.5.0，CI 用 pnpm/action-setup）
- Build/run: `pnpm run fetch` / `pnpm run translate` / `pnpm run ingest`（= fetch && translate）/ `pnpm run streams`
- Test: `pnpm test`（vitest，只覆蓋 `scripts/lib/` 純函式）；fetch/translate 仍以實跑觀察輸出驗證

## File layout

- `scripts/fetch.ts` — 抓 SOURCES 內 11 個 rss.app feed（花譜 2 帳號 + 3 搜尋 + 6 位成員主帳號），去重後 insert 進 `kaf_posts`；每個看到該列的 feed 把自己的歸屬併進 `seen_in`（`feedRank.memberships`），`feed_type` = rank 最高的 owner
- `scripts/translate.ts` — 取未翻譯列（每輪 ≤10 硬上限，tier 依 `seen_in` 包含 official/kafu/fan）跑 Gemini，回寫翻譯欄位
- `scripts/streams.ts` — 直播時程發現：名冊頻道 UULV/UULF RSS + 推文連結 → `videos.list` → upsert `kaf_streams`（見 `docs/DEVELOPMENT.md`「Streams」）
- `scripts/lib/` — 純函式（`videoIds` / `rssDiscovery` / `youtube` / `assembleRows` / `membersOnly` / `tweetBody` / `tweetAuthor` / `translateInput` / `feedRank` / `feedHealth` / `stripNul` / `feeds`）+ `__tests__/`
- `.github/workflows/ingest.yml` — 唯一 CI workflow：workflow_dispatch（由外部排程器觸發）+ secrets
- `.env.example` — 本地開發 key 範本（SUPABASE_URL / SUPABASE_SERVICE_KEY / GEMINI_API_KEY / YOUTUBE_API_KEY / RSS_FEEDS）
- `docs/specs/` — spec 入口（目前空）

## Constraints

- `ingest.yml` 不得加回 `schedule:`（被停用的 workflow 也會拒絕 workflow_dispatch，外部觸發會一起斷）。
- 10/1 前的貼文已刪除，`scripts/lib/retention.ts` 擋回流；不要繞過。
- 金鑰只放 gitignored 的 `.env`（名稱見 `.env.example`）或 Actions secrets，絕不進 git。rss.app feed id 也算（付費能力）：程式碼只寫 key（`feedUrl('kafu')`），id 放 `RSS_FEEDS`。
- Path-type constraints are mirrored in `kit.toml [protected]`; keep the two in sync (one glob per line).

## Conventions

- Conventional commits（`type(scope): 摘要`）；commit 前跑 `pnpm test`。
- 純邏輯放 `scripts/lib/` 並附 `__tests__/`；fetch/translate 本體以實跑輸出驗證。
- GitHub Actions: top-level `permissions: contents: read`, raised per job only when needed.
- GitHub Actions: pin every `uses:` to a 40-character commit SHA with a trailing `# vX.Y.Z` comment.

## Where to look

- `docs/DEVELOPMENT.md` — 指令、環境變數、schema、觸發、feed 維護、翻譯、直播時程、新增成員
- `docs/specs/` — requirement specs
- `.github/workflows/ingest.yml` — 部署與觸發（含註解說明）
