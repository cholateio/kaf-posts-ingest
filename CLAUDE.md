# kaf-posts-ingest

> CLAUDE.md（kit v4.2）。本檔只放專案內容；workflow / 派工 / review 規則由
> `.claude/rules/` 自動載入（kit-owned），見檔尾「Multi-agent kit」路由表。

## Project goal

RSS 抓取 + 翻譯 worker：每小時抓 KAF（花譜）相關 X/Twitter 帳號的 rss.app
RSS feed，寫入 Supabase `KAF_Posts` 表，再用 Gemini 翻譯未翻譯的貼文
（日→繁中，含註解/單字/文法欄位）回寫同一列。前端消費者是
**kaf-observatory**（舊名 virtual-desk）的 Reader overlay——唯讀 `KAF_Posts`。

## Stack

- Language: TypeScript 5.8 / Node 22（tsx 直跑 .ts，無編譯步驟，`noEmit: true`）
- 外部服務: Supabase（`@supabase/supabase-js`）、Google Gemini
  `gemini-2.5-flash`（`@google/generative-ai`）、rss.app（feed 供應方）
- 部署: GitHub Actions cron（`.github/workflows/ingest.yml`，每小時
  `0 * * * *` + workflow_dispatch 手動觸發）；secrets 走 Actions
- Build/run: `npm run fetch` / `npm run translate` / `npm run ingest`（= fetch && translate）
- Test: 無測試（package.json 無 test script）——改動後以實跑 fetch/translate 觀察輸出驗證

## File layout

- `scripts/fetch.ts` — 抓 SOURCES 內 4 個 rss.app feed，去重後 insert 進 `KAF_Posts`
- `scripts/translate.ts` — 取未翻譯列（每輪 ≤10 硬上限）跑 Gemini，回寫翻譯欄位
- `.github/workflows/ingest.yml` — 唯一 CI workflow：cron + secrets
- `.env.example` — 本地開發三把 key 範本（SUPABASE_URL / SUPABASE_SERVICE_KEY / GEMINI_API_KEY）
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
