# kaf-posts-ingest

[English](README.md) | **繁體中文**

你追蹤虛擬歌手花譜（KAF）和 KAMITSUBAKI 旗下的成員，想看懂她們 X 貼文的翻譯，也想把她們的 YouTube 直播整理成同一份時程表。GitHub Actions 每小時跑一次：抓取 X 的 feed，把新的日文貼文翻成繁體中文並附上單字和文法說明，再把貼文和直播時間寫進你自己的 Supabase 專案。

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

- **給學習者的翻譯**：每則日文貼文都有一份保留原本換行的繁體中文翻譯、5–8 個附讀音的單字，以及 1–3 個文法句型，以 JSON 存在原文旁邊。
- **過濾離題貼文**：來自 X 搜尋 feed 的貼文，推文本文必須提到主題，否則就丟掉；沒有假名、或實際文字不到 4 個字的貼文，會標記為不需翻譯。
- **一則推文一列**：同一則推文出現在好幾個 feed 時只存一次，並歸到最權威的那個 feed（依序是官方、成員帳號、可不的搜尋、粉絲的搜尋）；翻譯時官方貼文優先，每次執行翻 10 則。
- **直播時程**：名冊上每個頻道的直播與上傳播放清單，加上官方和成員推文裡的 YouTube 連結，都會透過 YouTube Data API 查詢，存下狀態、開始與結束時間，以及首播和會員限定的標記。

單一 feed 的輸入與輸出：

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

feed、頻道清單和過濾條件都是針對 KAF 和 KAMITSUBAKI 的成員名冊寫的，資料表定義也不在這個 repo 裡，所以你自己的版本要準備自己的 feed、頻道和資料表。

## 它怎麼運作

```
你的排程器，每小時 ──► GitHub Actions "Ingest" (workflow_dispatch)
   fetch      rss.app X feed ──► 相關性過濾 ──► kaf_posts
   translate  未翻譯的列 ──► Gemini ──► translation, vocabulary, grammar
   streams    YouTube 播放清單 + 推文連結 ──► YouTube Data API ──► kaf_streams
```

沒有伺服器，也沒有公開的端點。worker 只會寫入 Supabase，前端只要從 Supabase 讀取就好。

## 安裝

需要：GitHub 帳號、Supabase 專案、給 Gemini 用的 Google AI Studio API key、限定只能呼叫 YouTube Data API v3 的 Google Cloud API key、你追蹤的 X 帳號和搜尋所對應的 [rss.app](https://rss.app) feed，以及一個能每小時送出 HTTP 請求的東西。

1. Fork 本 repo。
2. 在 Supabase 建立 `kaf_posts` 和 `kaf_streams` 兩張資料表，欄位如上，`kaf_posts` 另外加上 `id` 和 `source_type`。`external_id` 和 `video_id` 必須唯一，`seen_in` 是 text 陣列，`vocabulary` 和 `grammar` 是 `jsonb`。實際寫入的內容請看 `scripts/fetch.ts`、`scripts/translate.ts`，以及 `scripts/lib/youtube.ts` 裡的 `StreamRow`。
3. 修改來源：`SOURCES`（`scripts/fetch.ts`）和 `TWEET_FEEDS` 裡的 feed key、`STREAM_CHANNEL_IDS`（`scripts/streams.ts`）裡的頻道 ID，以及 `scripts/lib/retention.ts` 裡的截止日期，它會忽略 2026 年 10 月 1 日以前發布的推文。
4. 在你的 fork 打開 **Settings → Secrets and variables → Actions → New repository secret**，新增五個 secret：`SUPABASE_URL` 填你的專案 URL、`SUPABASE_SERVICE_KEY` 填 service-role key、`GEMINI_API_KEY`、`YOUTUBE_API_KEY`，以及 `RSS_FEEDS`，內容是一個 JSON 物件，把 `scripts/fetch.ts` 用到的每個 feed key 對應到它的 rss.app feed id，例如 `{"kafu":"<id>"}`。
5. 打開 **Actions → Ingest → Run workflow**，看第一次執行的 log。
6. 讓你的排程器每小時送出 `POST https://api.github.com/repos/<you>/kaf-posts-ingest/actions/workflows/ingest.yml/dispatches`，body 是 `{"ref":"main"}`，用一把只限這個 repo、權限開 **Actions: Read and write** 的 fine-grained token 授權。workflow 本身沒有內建排程。

執行結果顯示綠燈，不代表貼文都翻譯成功了，因為單一貼文失敗不會讓整個 job 失敗。請看 log 和執行頁面上的 **Feed health** 警告。

## 隱私與安全

- 所有 key，以及 rss.app 的 feed id（`RSS_FEEDS`，一個 feed key 對應 id 的 JSON 物件），都存在 GitHub Actions secrets；在本機執行時則放在被 gitignore 的 `.env`。沒有任何一個會 commit 進 repo。
- service-role key 會繞過 row-level security。worker 要寫入就需要它；絕對不要把它放進前端。
- 貼文文字（去掉連結和結尾的作者行）會送到 Google 的 Gemini API。影片 ID 會送到 YouTube Data API。
- 只儲存公開貼文和公開的影片資訊：文字、媒體 URL、翻譯，以及直播的標題和時間。
- workflow 的 GitHub token 只能讀取這個 repo；所有寫入都送到 Supabase。

## 授權

[MIT](LICENSE)。
