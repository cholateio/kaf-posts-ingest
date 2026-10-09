# LESSONS

### 2026-07-28 rss.app 的 X 搜尋型 feed 有一成內容跟主題無關
- Context: user 發現 KAFU feed 混入大量非可不內容。四個 feed 中兩個是帳號
  timeline(乾淨),兩個是 `x.com/search?q=花譜` 與 `x.com/search?q=可不 kafu`。
- Error: 搜尋型 feed 撈回的貼文有一成內文完全不含主題詞。X 對 CJK 查詢會拆字
  (`板倉可奈　永久不滅` 命中 可+不、`瀧廉太郎の「花」の自筆譜` 命中 花+譜),
  Top 分頁還會再做關聯擴展;也會命中帳號名(`@MatsuriCafu` → Cafu)。
- Solution: `fetch.ts` 的 SOURCES 加 `mustMatch` 正則,只對搜尋型 feed 生效,
  insert 前擋掉。規則先拿備份的 5784 筆歷史資料量測命中率與誤殺率才上線。
- Rule: 第三方 feed 的「搜尋」不是精確匹配——接進 DB 前先拿歷史樣本量測雜訊率,
  過濾規則要同時驗誤殺(被丟掉的逐筆看過)而不只是驗濾掉多少。

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

### 2026-10-09 GitHub 排程被 60 天停用,且停用會連帶擋掉 workflow_dispatch
- Context: Reader 8 天沒新貼文;ingest.yml 用 GitHub `schedule:` 每小時跑。
- Error: workflows state=`disabled_inactivity`(10/1 起)。重新 enable 後 13 小時內
  0 次排程觸發(對照 life-tracker 同期每次晚 3–7 小時)。實測 disabled 時
  dispatch API 回 `422 Cannot trigger a 'workflow_dispatch' on a disabled workflow`。
  fan feed 10/2–10/7 貼文永久遺失(rss.app 只掛 25 筆)。
- Solution: 移除 `schedule:`,改由 GCP Cloud Scheduler(kaf-obs)每小時用 fine-grained
  PAT 打 workflow_dispatch API。
- Rule: 需要準時或長期無人看管的排程不要用 GitHub `schedule:`,也不要「留著當備援」——
  它被停用時會把外部 dispatch 一起拖下水。
