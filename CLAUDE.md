# kaf-posts-ingest

> CLAUDE.md（kit v4.2）。本檔只放專案內容；workflow / 派工 / review 規則由
> `.claude/rules/` 自動載入（kit-owned），見檔尾「Multi-agent kit」路由表。

## Project goal

RSS 抓取 + 翻譯 worker：每小時抓 KAF（花譜）相關 X/Twitter 帳號的 rss.app
RSS feed，寫入 Supabase `kaf_posts` 表，再用 Gemini 翻譯未翻譯的貼文
（日→繁中，含註解/單字/文法欄位）回寫同一列。前端消費者是
**kaf-observatory**（舊名 virtual-desk）的 Reader overlay——唯讀 `kaf_posts`。

## Stack

- Language: TypeScript 5.8 / Node 22（tsx 直跑 .ts，無編譯步驟，`noEmit: true`）
- 外部服務: Supabase（`@supabase/supabase-js`）、Google Gemini
  `gemini-3.5-flash-lite`（`@google/generative-ai`；2.5 系列 2026-07 被 Google 收掉，見 LESSONS）、rss.app（feed 供應方）
- 部署: GitHub Actions 執行，**觸發來源是 GCP Cloud Scheduler**（專案 `kaf-obs`，
  job `kaf-posts-ingest-hourly`，`15 * * * *`，用 fine-grained PAT 打
  workflow_dispatch API）；secrets 走 Actions。`ingest.yml` 只有
  `workflow_dispatch`，**不要加回 `schedule:`**——理由見該檔註解與
  `docs/LESSONS.md` 2026-10-09
- 套件管理: pnpm（`packageManager` 欄位鎖 pnpm@11.5.0，CI 用 pnpm/action-setup）
- Build/run: `pnpm run fetch` / `pnpm run translate` / `pnpm run ingest`（= fetch && translate）/ `pnpm run streams`
- Test: `pnpm test`（vitest，只覆蓋 `scripts/lib/` 純函式）；fetch/translate 仍以實跑觀察輸出驗證

## File layout

- `scripts/fetch.ts` — 抓 SOURCES 內 9 個 rss.app feed（花譜 2 帳號 + 3 搜尋 + 4 位成員主帳號），去重後 insert 進 `kaf_posts`
- `scripts/translate.ts` — 取未翻譯列（每輪 ≤10 硬上限）跑 Gemini，回寫翻譯欄位
- `scripts/streams.ts` — 直播時程發現：名冊頻道 UULV/UULF RSS + 推文連結 → `videos.list` → upsert `kaf_streams`（見 README「Streams」）
- `scripts/lib/` — 純函式（`videoIds` / `rssDiscovery` / `youtube` / `assembleRows` / `membersOnly` / `tweetBody` / `feedRank` / `feedHealth` / `stripNul`）+ `__tests__/`
- `.github/workflows/ingest.yml` — 唯一 CI workflow：workflow_dispatch（由 Cloud Scheduler 觸發）+ secrets
- `.env.example` — 本地開發四把 key 範本（SUPABASE_URL / SUPABASE_SERVICE_KEY / GEMINI_API_KEY / YOUTUBE_API_KEY）
- `docs/specs/` — spec 入口（目前空）

## Project-specific constraints（禁區與硬規則）

（目前無。踩到坑再累積；路徑型禁區同步加進 `.claude/protected-paths`。）

## Multi-agent kit

workflow / 派工 / review / 判斷規則由 `.claude/rules/` 每 session 自動載入
（kit-owned，由 kit repo 的 `init.sh --update` 維護，不要在本專案裡改）。
情境對應的按需文件：

| 情境 | 讀這裡 |
|------|--------|
| 卡關了 / 想宣告完成 / 猶豫要不要問 user | `.claude/docs/judgment-matrix.md` |
| 要派工給 subagent | `/kit-dispatch` skill（五種模板） |
| 要做 UI / 設計 schema / 同一 bug 連續卡 / 引入外部服務 / 定架構 | `.claude/docs/verification-signals.md`（命中哪節讀哪節） |
| 要記教訓 / 查歷史教訓 / 想改 harness 檔案 | `docs/LESSONS.md`（append；動大手術前先掃一眼）/ kit-evolution 規則（自動已載入） |
