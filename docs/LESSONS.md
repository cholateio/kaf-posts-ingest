# LESSONS

### 2026-07-28 綠燈的 CI 掩護了 12 天的翻譯全滅
- Context: user 回報「翻譯很久沒動了」。Actions 最近 100 次 run 全 success,
  PROJECT.toml 也寫著「近 100 次全綠」,表面上專案健康。
- Error: `[404 Not Found] This model models/gemini-2.5-flash is no longer
  available to new users.` 二分搜尋 400 次 run 的 log 定位斷點:
  2026-07-15T18:59Z 最後一次成功,20:14Z 起每輪都是 `Done. Translated 0/10`。
  Google 於 2026-07-09 起對新用戶提前關閉 2.5 系列,早於官方公告的 10-16。
- Solution: 換 `gemini-3.5-flash-lite`。3.x 同時把 `thinkingConfig.thinkingBudget`
  換成 `thinkingConfig.thinkingLevel`(舊欄位是硬 400),用 curl 一次掃完該維度
  的四種取值才定案,沒有逐格試。
- Rule: 批次腳本的 per-row catch 若不影響 exit code,CI 綠燈就不覆蓋業務成敗——
  驗證這種 worker 要讀 log 的成功計數,不是讀 run 的 conclusion。

### 2026-07-28 rss.app feed 只有 25 筆,清表等於永久失去歷史
- Context: user 要求重置 KAF_Posts(當時 5995 筆,其中 4120 筆已翻譯)。
- Error: 尚未發生——動手前先 curl 四個 feed 實測,各只掛 25 筆,fan feed 最舊
  一筆是當天早上,滾動以小時計。清表後 fetch 只回補得了 91 筆。
- Solution: 先告知不可逆與回補上限,user 確認後才執行,並在刪除前把整表匯出成
  JSONL(5995 行,校對行數/不重複 id/已翻譯數三項才算過)。
- Rule: 對唯讀外部來源建立的資料表,刪除前先量測來源能回補多少——上游是滾動
  視窗時,DB 是唯一的歷史副本。
