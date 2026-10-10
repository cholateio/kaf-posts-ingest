# kaf_posts 多重歸屬（seen_in）實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一則推文可以同時屬於多個 Reader 分頁：`kaf_posts.seen_in TEXT[]` 記錄「哪些 feed 看過這列」，分頁用包含篩選；`feed_type` 保留為主歸屬（翻譯優先序）。

**Architecture:** 三段、兩個 repo。(A) observatory 的 migration 0008 加欄位、回填、GIN index，用 Supabase MCP 套用；(B) ingest `fetch.ts` 對每個看到該列的 feed 把「該 entry 解析出的歸屬集合」併進 `seen_in`，純函式集中在 `scripts/lib/feedRank.ts`；(C) observatory Reader 兩條 API 改用 `seen_in @> {tab}` 篩選，「已轉發」改由「作者 ∉ 分頁帳號」判定，不再 parse 標題。

**Tech Stack:** TypeScript 5.8 / Node 22 / tsx / vitest（ingest）；Next.js + vitest（observatory）；Supabase Postgres 17（`text[]`、GIN）。

**Spec:** `docs/reader-pipeline-review-2026-10-10.md` §4（codex 審查 A/B 兩項）與 §5（user 決定，含 2026-10-11 addendum「fan = fans」）。記憶檔 `next-multi-membership` 同步。

## Global Constraints

- `ingest.yml` 只有 `workflow_dispatch`，不加 `schedule:`（CLAUDE.md）。
- 代碼內註解一律英文；只寫不變量／跨檔耦合／非顯然 why／附日期收據。
- `POST_COLUMNS` 是顯式白名單，不得 `select("*")`（observatory `constants.ts`）。
- `official` 只代表 @virtual_kaf／@kaf_info；成員帳號各自一個 `feed_type`，不併入 `official`（記憶 `project-priorities-and-feed-type`）。
- `translate.ts` 的 `FEED_PRIORITY = ['official','kafu','fan']` 本計畫**不動**；成員類別維持不翻譯，等成員分頁（下一階段）。
- Reader 的 API 查詢參數名 `feed_type` 保留（`api.ts`、`MobileHub.tsx` 都在用），語意改為「分頁 id」。
- 部署順序硬限制：**`gh workflow disable Ingest` → migration → ingest push → `gh workflow enable Ingest` → observatory push**。migration 之後**零次**舊 writer run 是正確性前提（codex 計畫審查 2026-10-11 round 3：舊 kafu feed 看到官方可不推文時無法事後補 `kafu` 歸屬）。workflow 停用期間 Cloud Scheduler 的 dispatch 會失敗一次，無害；gcloud 未安裝，Scheduler 本身不動。trigger／CHECK／清理 SQL 是第二道防線，不是替代。

## 設計決定（計畫層，codex 請挑戰）

1. **歸屬集合的定義**：一個 entry 由某 source 抓到時，歸屬集合 `memberships(source, author)` =
   - timeline feed（official 2 個、成員 4 個）：`{source.feedType} ∪ {authorType(author)}`。
     例：理芽時間軸出現她轉推的花譜推文 → `{rim, official}`；理芽自己的推文 → `{rim}`。
     理由：作者本人的時間軸 feed「按定義」含有該推文，不必等那個 feed 的 25 則視窗剛好涵蓋才加——這同時修了 §4 F（視窗錯過即永久低標）。
   - fan search feed（×2，`fansOnly: true`）：作者是已知帳號 → **只有** `{authorType}`（不加 fan，「fan = fans」）；否則 `{fan}`。
   - kafu search feed：**主題式**分頁（關於可不），不是粉絲分頁，規則同 timeline：`{kafu} ∪ {authorType}`。CIEL 提到可不的推文留在 Kafu 分頁；官方帳號關於可不的推文會重新出現在 Kafu 分頁（a290e68 之前的行為，單一歸屬時代被迫二選一——codex 計畫審查 2026-10-11 round 2 medium）。
   - `authorType` 來自單一全域表 `KNOWN_AUTHORS`（official 2 + 成員 4 handle），取代現行每個 source 的 `authorFeedType`。
2. **主歸屬** `feed_type = 集合中 rank 最高者`（沿用 `RANK`：official 3 > 成員 2 > kafu 1 > fan 0）；已存在列只在新集合中有更高 rank 時改寫（現行 retag 語意不變）。成員之間同 rank → 先存者保留，`seen_in` 兩者都有。
3. **回填**：`seen_in = {feed_type} ∪ {authorType(author)}`；`fan` 列若作者是已知帳號 → `feed_type` 改成作者類別、`seen_in = {作者類別}`（fan 不保留）；`kafu` 列若作者已知 → `feed_type` 改成作者類別、`seen_in = {kafu, 作者類別}`。2026-10-11 實測：fan 內 2 列 CIEL + 1 列春猿火；kafu 內 0 列；另 2 列 official-by-rim 與 1 列 rim-by-harusaruhi 只加成員。
4. **已轉發標記**：`retweetedInto(externalId, tab)`：分頁有帳號清單（`TAB_RETWEET[tab]`）且作者 ∉ 清單 → 顯示「`<label>` retweeted」。fan/kafu 分頁無帳號清單 → 永不顯示（實測 fan/kafu 0 列 `RT by`）。label：official 分頁用 "KAF"（兩個帳號分不出誰轉的，標題前綴不再採信）；成員分頁日後填 `@RIM_virtual` 等。
5. **寫回方式**：不用 DB function／RPC，純函式算出每列 patch，依 patch 內容分組後 `update().in()`。每小時各 feed 最多 25 列、穩態幾乎 0 列需改，分組後通常 ≤2 次 update／feed。fetch 由 Cloud Scheduler 單線程觸發，無併發寫入競態。
6. **§4 B（retag 不更新 title）**：標記改由作者判定後 title 不再被讀，B 自然消失，不另修。
7. **寫入端版本偏差由 DB 守住**：不變量 = **`feed_type ∈ seen_in`**（owner 分頁一定看得到）。migration 加 `BEFORE INSERT OR UPDATE` trigger（NULL → `{feed_type}`；owner 不在陣列 → append）與 `CHECK (seen_in @> ARRAY[feed_type])`。舊 ingest 的 insert（無 seen_in）與 retag（`UPDATE {feed_type}` 不帶 seen_in，`fetch.ts:272`）都被 trigger 補正；顯式違反直接報錯。
   trigger **不**處理「已知作者不得有 fan 歸屬」也**不**知道哪些列是 kafu feed 看過的（那需要把 handle 表、rank 與 feed 視窗搬進 SQL）。所以：(a) **硬切換**——migration 前 `gh workflow disable Ingest`，新 ingest push 後才 `gh workflow enable Ingest`，舊 writer 在 migration 後零次 run（codex round 3）；(b) Task 7 的冪等清理 SQL 在 observatory 上線前跑一次作為驗證（預期更新 0 列）；(c) **不回滾 ingest 到 0008 之前的版本**（若被迫回滾，回滾期間結束後重跑清理 SQL，並接受該期間 kafu feed 看到的官方／成員可不推文只在 owner 分頁）。

## Review Focus

1. **同一推文被兩個成員轉推**（rim 先存，harusaruhi 後見）：`feed_type` 須留 rim，`seen_in` 須為 `{rim, harusaruhi}`，不可互搶（Task 2 測試 3）。
2. **匿名 URL `x.com/i/status/…`**（author = null）：不得套 KNOWN_AUTHORS，歸屬只剩 source；Reader 不顯示 retweeted（Task 2 測試 4、Task 6 測試 3）。
3. **handle 大小寫**（`RIM_virtual`、`CIEL_VanillaSky`）：`tweetAuthor` 已小寫化，`KNOWN_AUTHORS` key 必須小寫（Task 2 測試 5）。
4. **省略 `seen_in` 的舊寫入端**（migration 後、ingest 上線前的 CI run）：insert 要補成 `{feed_type}`；舊 retag `UPDATE {feed_type:'official'}` 要讓 seen_in 跟著含 official；舊 writer 把成員推文存成 fan 的殘留由 Task 7 清理 SQL 清掉（Task 1 Step 4 實測 insert／update 兩種；Task 7 Step 2 清理後驗證）。
5. **CDN 快取舊回應**（`s-maxage=60`）沒有 `seen_in` 欄位：`Post.seen_in` 只被 API 篩選用，`PostCard` 不讀它，所以舊快取只影響一分鐘的分頁內容，不會崩（Task 5 不讀 `seen_in` 即為測試）。

---

## 模型／effort 建議（kit-workflow 要求）

| Phase | Tasks | 主對話模型 | effort | 理由 | 升級觸發 |
|---|---|---|---|---|---|
| A 資料庫 | 1 | Fable 5 | high | 不可逆：改 4k 列的 feed_type／seen_in，SQL 要一次對 | 回填驗證 SQL 任一計數不符預期 → 停，不補 patch |
| B ingest | 2–3 | Fable 5 | medium | 純函式有測試鎖、fetch.ts 改動集中在一段 | 實跑 fetch 出現 retag/joined 數異常（>10）或 insert 錯 |
| C observatory | 4–7 | Opus 4.8 | medium | 介面已凍結（欄位名、prop 名在本計畫定死） | TS 型別錯誤擴散到計畫未列的檔案 → 升 Fable |

---

### Task 1: migration 0008（observatory repo）——加欄、回填、索引、套用

**Files:**
- Create: `/home/cholate/kaf-observatory/supabase/migrations/0008_kaf_posts_seen_in.sql`

**Interfaces:**
- Produces: `kaf_posts.seen_in TEXT[] NOT NULL DEFAULT '{}'`；GIN index `idx_kaf_posts_seen_in`。

- [ ] **Step 1: 寫 migration 檔**

```sql
-- 0008_kaf_posts_seen_in.sql — multi-membership for kaf_posts.
-- One tweet can be in several feeds (an official retweet of a talent's tweet
-- belongs to the KAF tab and the talent's tab). feed_type stays the single
-- owner used for translation priority; seen_in lists every feed that saw
-- the row and is what the Reader tabs filter on (seen_in @> '{tab}').
-- Design: kaf-posts-ingest docs/reader-pipeline-review-2026-10-10.md §5.

ALTER TABLE kaf_posts ADD COLUMN seen_in TEXT[] NOT NULL DEFAULT '{}';

-- Backfill 1: every row is at least in the feed that owns it.
UPDATE kaf_posts SET seen_in = ARRAY[feed_type];

-- Backfill 2 ("fan = fans", decision 2026-10-11): the fan search feed
-- stored tweets authored by official/talent accounts; they belong to that
-- account only. 3 rows on 2026-10-11. The kafu search is topical, so a
-- known author's row there keeps kafu and gains the account (0 rows today).
UPDATE kaf_posts p
SET feed_type = a.t, seen_in = ARRAY[a.t]
FROM (VALUES
    ('virtual_kaf', 'official'), ('kaf_info', 'official'),
    ('rim_virtual', 'rim'), ('harusaruhi', 'harusaruhi'),
    ('isekaijoucho', 'isekaijoucho'), ('ciel_vanillasky', 'ciel')
) AS a(handle, t)
WHERE lower(split_part(p.external_id, '/', 4)) = a.handle
  AND p.feed_type = 'fan';

UPDATE kaf_posts p
SET feed_type = a.t, seen_in = ARRAY['kafu', a.t]
FROM (VALUES
    ('virtual_kaf', 'official'), ('kaf_info', 'official'),
    ('rim_virtual', 'rim'), ('harusaruhi', 'harusaruhi'),
    ('isekaijoucho', 'isekaijoucho'), ('ciel_vanillasky', 'ciel')
) AS a(handle, t)
WHERE lower(split_part(p.external_id, '/', 4)) = a.handle
  AND p.feed_type = 'kafu';

-- Backfill 3: the author's own timeline feed contains the tweet by
-- definition, so an official retweet of @RIM_virtual is also in `rim`.
-- 3 rows on 2026-10-11.
UPDATE kaf_posts p
SET seen_in = array_append(p.seen_in, a.t)
FROM (VALUES
    ('virtual_kaf', 'official'), ('kaf_info', 'official'),
    ('rim_virtual', 'rim'), ('harusaruhi', 'harusaruhi'),
    ('isekaijoucho', 'isekaijoucho'), ('ciel_vanillasky', 'ciel')
) AS a(handle, t)
WHERE lower(split_part(p.external_id, '/', 4)) = a.handle
  AND NOT p.seen_in @> ARRAY[a.t];

-- Invariant: the owner tab always sees the row (feed_type = ANY(seen_in)).
-- Writers that predate seen_in (an older ingest, a rollback) insert without
-- it and retag with `UPDATE {feed_type}` alone; the trigger repairs both so
-- no row goes invisible. The CHECK rejects explicit violations outright.
CREATE FUNCTION kaf_posts_owner_in_seen_in() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.seen_in IS NULL THEN
        NEW.seen_in := ARRAY[NEW.feed_type];
    ELSIF NOT (NEW.seen_in @> ARRAY[NEW.feed_type]) THEN
        NEW.seen_in := array_append(NEW.seen_in, NEW.feed_type);
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER kaf_posts_owner_in_seen_in
    BEFORE INSERT OR UPDATE OF feed_type, seen_in ON kaf_posts
    FOR EACH ROW EXECUTE FUNCTION kaf_posts_owner_in_seen_in();

ALTER TABLE kaf_posts ADD CONSTRAINT kaf_posts_owner_in_seen_in
    CHECK (seen_in @> ARRAY[feed_type]);

-- Tab queries are `seen_in @> '{x}'`; GIN serves array containment.
-- idx_posts_feed_type stays for translate.ts (still filters feed_type).
CREATE INDEX idx_kaf_posts_seen_in ON kaf_posts USING GIN (seen_in);
```

- [ ] **Step 2: 套用前快照（MCP `execute_sql`，project `ukmcixycjqrznctudzrx`）**

先停掉寫入端（硬規則，見 Global Constraints）。停用只擋新的 dispatch，不會取消已排隊／執行中的 run（`ingest.yml` 的 `cancel-in-progress: false` 會讓 :15 撞上停用瞬間的 run 排隊），所以停用後要**排空**再動 DB：

```bash
cd /home/cholate/kaf-posts-ingest && gh workflow disable Ingest && gh workflow list   # Ingest 顯示 disabled_manually
until [ "$(gh run list --workflow Ingest --status queued --json databaseId --jq length)" = 0 ] \
   && [ "$(gh run list --workflow Ingest --status in_progress --json databaseId --jq length)" = 0 ]; do sleep 20; done
gh run list --limit 1 --json createdAt,status,conclusion --jq '.[0]'   # 記下：這是切換邊界，之後不得再有 run
```
Expected：迴圈退出；最後一行 `status: completed`。從這裡到 Task 3 Step 6 重新啟用之間沒有任何 ingest run。

同時記下 Backfill 2 會改 `feed_type` 的列（abort 時要還原）：
```sql
select external_id, feed_type from kaf_posts
where feed_type in ('fan','kafu') and lower(split_part(external_id,'/',4)) in
  ('virtual_kaf','kaf_info','rim_virtual','harusaruhi','isekaijoucho','ciel_vanillasky');
```
Expected（2026-10-11）：3 列，全部 `fan`。

**Abort 程序**——只適用於 **新 writer 第一次碰到正式資料之前**，即 Task 3 Step 5（本地實跑 fetch）之前；此時 workflow 仍停用、DB 只被 migration 改過，下面的 SQL 是完整還原。Task 3 Step 5 之後新 writer 的分類（已知作者的 search hit 歸帳號、seen_in 併集）已經寫進資料，回滾 = 另寫一支正向資料遷移（舊規則重新分類新 writer 寫過的列），不在本計畫內；屆時先 `gh workflow disable Ingest`＋排空；若 Task 3 尚未 push（Step 5 失敗在 Step 6 之前）就直接捨棄本地改動（`git checkout -- scripts/`），已 push 才 `git revert` 並 push；然後處理資料，最後才 enable。trigger 是 `UPDATE OF feed_type, seen_in`，對欄位有依賴，單純 `DROP COLUMN` 會被擋；函式不隨欄位掉。整段一個交易，還原值取自上面記下的 `(external_id, feed_type)`：
```sql
begin;
drop trigger kaf_posts_owner_in_seen_in on kaf_posts;
drop function kaf_posts_owner_in_seen_in();
alter table kaf_posts drop column seen_in;   -- CHECK + GIN index go with the column
update kaf_posts p set feed_type = v.t
from (values ('<external_id_1>', 'fan'), ('<external_id_2>', 'fan'), ('<external_id_3>', 'fan')) as v(id, t)
where p.external_id = v.id;
commit;
```
然後 `gh workflow enable Ingest`（舊 writer 不認識 seen_in，欄位已掉，照常運作）。

```sql
select feed_type, count(*) from kaf_posts group by 1 order by 1;
```
Expected（2026-10-11）: ciel 21 / fan 3414 / harusaruhi 25 / isekaijoucho 28 / kafu 259 / official 239 / rim 27。若數字變動（每小時有新列）記下實值。

- [ ] **Step 3: 用 MCP `apply_migration` 套用**，name `kaf_posts_seen_in`，query = Step 1 全文。

- [ ] **Step 4: 驗證回填**

```sql
select
  count(*) filter (where seen_in = '{}') as empty_seen_in,
  count(*) filter (where not seen_in @> array[feed_type]) as owner_missing,
  count(*) filter (where cardinality(seen_in) > 1) as multi,
  count(*) filter (where feed_type in ('fan','kafu')
      and lower(split_part(external_id,'/',4)) in ('virtual_kaf','kaf_info','rim_virtual','harusaruhi','isekaijoucho','ciel_vanillasky')) as fan_by_known
from kaf_posts;
```
Expected: `empty_seen_in = 0`、`owner_missing = 0`、`multi = 3`（官方轉 rim ×2、rim 轉 harusaruhi ×1）、`fan_by_known = 0`。
再跑 `select feed_type, count(*) …`：fan 應比 Step 2 少 3，ciel +2、harusaruhi +1，其餘不變（扣掉這段期間新進列）。

trigger 與 CHECK 實測（同一交易內回滾，不留資料）：

```sql
begin;
insert into kaf_posts (source_type, feed_type, external_id, original_text, published_at)
  values ('x', 'rim', 'https://x.com/RIM_virtual/status/0', 'trigger test', now());
select seen_in from kaf_posts where external_id = 'https://x.com/RIM_virtual/status/0';
-- old-writer retag shape: feed_type only
update kaf_posts set feed_type = 'official' where external_id = 'https://x.com/RIM_virtual/status/0';
select feed_type, seen_in from kaf_posts where external_id = 'https://x.com/RIM_virtual/status/0';
rollback;
```
Expected: 第一句 `{rim}`；第二句 `official | {rim,official}`。再跑：
```sql
begin;
update kaf_posts set seen_in = '{}' where external_id = (select external_id from kaf_posts limit 1);
rollback;
```
Expected: 不報錯，但 `select seen_in …` 同一列回 `{<feed_type>}`——trigger 在 CHECK 之前把 owner 補回去。CHECK 只是最後防線（直接 `ALTER TABLE … DISABLE TRIGGER` 的人才會碰到）。

- [ ] **Step 5: commit（observatory）**

```bash
cd /home/cholate/kaf-observatory && git add supabase/migrations/0008_kaf_posts_seen_in.sql && git commit -m "feat(db): kaf_posts.seen_in multi-membership (migration 0008, applied)"
```
**不 push observatory**——Reader 程式碼（Task 4–6）要跟 migration 一起上，否則線上 Reader 不受影響但也無意義；此時 DB 已有欄位，舊 ingest 的插入由 trigger 補成 `{feed_type}`，不會隱形。

---

### Task 2: `feedRank.ts` 純函式——`memberships` / `ownerOf` / `membershipPatches`

**Files:**
- Modify: `scripts/lib/feedRank.ts`（整檔重寫，`idsToRetag` 刪除）
- Test: `scripts/lib/__tests__/feedRank.test.ts`（整檔重寫）

**Interfaces:**
- Produces:
  ```ts
  export type FeedType = 'official' | 'fan' | 'kafu' | 'rim' | 'harusaruhi' | 'isekaijoucho' | 'ciel';
  export const KNOWN_AUTHORS: Record<string, FeedType>;           // lowercase handle -> type
  export function memberships(source: FeedType, author: string | null, fansOnly: boolean): FeedType[];
  export function ownerOf(types: FeedType[]): FeedType;            // highest RANK
  export interface ExistingRow { external_id: string; feed_type: string; seen_in: string[] }
  export interface RowPatch { ids: string[]; patch: { feed_type?: FeedType; seen_in: string[] } }
  export function membershipPatches(types: FeedType[], existing: ExistingRow[]): RowPatch[];
  ```
- `tweetAuthor()`（既有，回傳小寫 handle 或 null）由 fetch.ts 先呼叫，再傳進 `memberships`。

- [ ] **Step 1: 寫失敗測試（取代原檔）**

```ts
import { describe, expect, it } from 'vitest';
import { memberships, ownerOf, membershipPatches } from '../feedRank';

const row = (id: string, feed_type: string, seen_in: string[]) => ({ external_id: id, feed_type, seen_in });

describe('memberships', () => {
    it('a timeline feed adds itself and the author\'s own feed (talent retweets an official tweet)', () => {
        expect(memberships('rim', 'virtual_kaf', false)).toEqual(['rim', 'official']);
        expect(memberships('official', 'rim_virtual', false)).toEqual(['official', 'rim']);
    });
    it('a timeline feed with its own author is just itself', () => {
        expect(memberships('rim', 'rim_virtual', false)).toEqual(['rim']);
        expect(memberships('official', 'kaf_info', false)).toEqual(['official']);
    });
    it('a fans-only search feed files a known author under that account only, never fan', () => {
        expect(memberships('fan', 'rim_virtual', true)).toEqual(['rim']);
        expect(memberships('fan', 'virtual_kaf', true)).toEqual(['official']);
        expect(memberships('fan', 'someone_else', true)).toEqual(['fan']);
    });
    it('the topical kafu search keeps kafu and adds the known author (CIEL tweeting about 可不)', () => {
        expect(memberships('kafu', 'ciel_vanillasky', false)).toEqual(['kafu', 'ciel']);
        expect(memberships('kafu', 'virtual_kaf', false)).toEqual(['kafu', 'official']);
        expect(memberships('kafu', 'someone_else', false)).toEqual(['kafu']);
    });
    it('an anonymous /i/status URL (author null) adds nothing beyond the source', () => {
        expect(memberships('fan', null, true)).toEqual(['fan']);
        expect(memberships('rim', null, false)).toEqual(['rim']);
    });
    it('handles are matched lowercase (tweetAuthor lowercases; KNOWN_AUTHORS keys must too)', () => {
        expect(memberships('fan', 'ciel_vanillasky', true)).toEqual(['ciel']);
        expect(memberships('fan', 'isekaijoucho', true)).toEqual(['isekaijoucho']);
        expect(memberships('fan', 'harusaruhi', true)).toEqual(['harusaruhi']);
    });
});

describe('ownerOf', () => {
    it('picks the highest-ranked type: official > talent > kafu > fan', () => {
        expect(ownerOf(['rim', 'official'])).toBe('official');
        expect(ownerOf(['fan', 'kafu'])).toBe('kafu');
        expect(ownerOf(['harusaruhi', 'rim'])).toBe('harusaruhi'); // tie: first wins
    });
});

describe('membershipPatches', () => {
    it('appends the new memberships and retags the owner when outranked (official claims a fan row)', () => {
        expect(membershipPatches(['official'], [row('a', 'fan', ['fan'])])).toEqual([
            { ids: ['a'], patch: { feed_type: 'official', seen_in: ['fan', 'official'] } },
        ]);
    });
    it('appends without retag when not outranked (talent feed sees an official-owned row)', () => {
        expect(membershipPatches(['rim'], [row('a', 'official', ['official'])])).toEqual([
            { ids: ['a'], patch: { seen_in: ['official', 'rim'] } },
        ]);
    });
    it('two talents retweeting one tweet: both in seen_in, first owner kept', () => {
        expect(membershipPatches(['harusaruhi'], [row('a', 'rim', ['rim'])])).toEqual([
            { ids: ['a'], patch: { seen_in: ['rim', 'harusaruhi'] } },
        ]);
    });
    it('skips rows that already carry every membership', () => {
        expect(membershipPatches(['fan'], [row('a', 'official', ['official', 'fan']), row('b', 'fan', ['fan'])])).toEqual([]);
    });
    it('groups rows that end up with the same patch into one update', () => {
        expect(membershipPatches(['official'], [row('a', 'fan', ['fan']), row('b', 'fan', ['fan']), row('c', 'kafu', ['kafu'])])).toEqual([
            { ids: ['a', 'b'], patch: { feed_type: 'official', seen_in: ['fan', 'official'] } },
            { ids: ['c'], patch: { feed_type: 'official', seen_in: ['kafu', 'official'] } },
        ]);
    });
    it('a legacy feed_type it does not rank keeps its owner but still gains membership', () => {
        expect(membershipPatches(['official'], [row('a', 'legacy_yt', ['legacy_yt'])])).toEqual([
            { ids: ['a'], patch: { seen_in: ['legacy_yt', 'official'] } },
        ]);
    });
    it('a multi-type membership set (talent retweet of official) retags to the top type', () => {
        expect(membershipPatches(['rim', 'official'], [row('a', 'rim', ['rim'])])).toEqual([
            { ids: ['a'], patch: { feed_type: 'official', seen_in: ['rim', 'official'] } },
        ]);
    });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd /home/cholate/kaf-posts-ingest && pnpm test -- feedRank`
Expected: FAIL，`memberships is not a function`／export 不存在。

- [ ] **Step 3: 實作 `scripts/lib/feedRank.ts`（整檔）**

```ts
export type FeedType = 'official' | 'fan' | 'kafu' | 'rim' | 'harusaruhi' | 'isekaijoucho' | 'ciel';

// One tweet can sit in several feeds (the fan search finds 花譜's own tweets,
// official accounts retweet talents, talents retweet official). kaf_posts
// keeps one row per external_id: `seen_in` lists every feed that saw it
// (Reader tabs filter on containment) and `feed_type` is the single owner
// used for translation priority — the highest-ranked member. Rank is
// deliberate: talents sit above kafu/fan (decision 2026-10-10).
const RANK: Record<FeedType, number> = {
    official: 3,
    rim: 2,
    harusaruhi: 2,
    isekaijoucho: 2,
    ciel: 2,
    kafu: 1,
    fan: 0,
};

// Lowercase X handles (tweetAuthor lowercases) of the accounts that have a
// feed of their own. Must stay in sync with the account feeds in
// scripts/fetch.ts SOURCES and kaf-observatory TAB_RETWEET.
export const KNOWN_AUTHORS: Record<string, FeedType> = {
    virtual_kaf: 'official',
    kaf_info: 'official',
    rim_virtual: 'rim',
    harusaruhi: 'harusaruhi',
    isekaijoucho: 'isekaijoucho',
    ciel_vanillasky: 'ciel',
};

/**
 * Feeds an entry belongs to when `source` fetched it: the source plus the
 * author's own feed, which contains the tweet by definition whether or not
 * its 25-item window still shows it. The topical kafu search follows the
 * same rule. A fans-only feed is the exception: a known account's tweet is
 * that account's, not a fan post ("fan = fans", decision 2026-10-11).
 */
export function memberships(source: FeedType, author: string | null, fansOnly: boolean): FeedType[] {
    const own = author ? KNOWN_AUTHORS[author] : undefined;
    if (fansOnly) return [own ?? source];
    return own && own !== source ? [source, own] : [source];
}

/** Highest-ranked type; ties keep the earlier element. */
export function ownerOf(types: FeedType[]): FeedType {
    return types.reduce((best, t) => (RANK[t] > RANK[best] ? t : best));
}

export interface ExistingRow {
    external_id: string;
    feed_type: string;
    seen_in: string[];
}

export interface RowPatch {
    ids: string[];
    patch: { feed_type?: FeedType; seen_in: string[] };
}

/**
 * Updates for rows that already exist: append missing memberships, retag the
 * owner only when `types` outranks it. Rows needing the same patch share one
 * entry so fetch.ts issues one UPDATE per distinct patch.
 */
export function membershipPatches(types: FeedType[], existing: ExistingRow[]): RowPatch[] {
    const groups = new Map<string, RowPatch>();
    const top = ownerOf(types);
    for (const r of existing) {
        const seen = [...r.seen_in, ...types.filter((t) => !r.seen_in.includes(t))];
        const stored = r.feed_type in RANK ? RANK[r.feed_type as FeedType] : Infinity;
        const retag = RANK[top] > stored;
        if (seen.length === r.seen_in.length && !retag) continue;
        const patch: RowPatch['patch'] = retag ? { feed_type: top, seen_in: seen } : { seen_in: seen };
        const key = JSON.stringify(patch);
        const g = groups.get(key);
        if (g) g.ids.push(r.external_id);
        else groups.set(key, { ids: [r.external_id], patch });
    }
    return [...groups.values()];
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `pnpm test -- feedRank`
Expected: PASS，15 tests。再跑 `pnpm test` 全綠（fetch.ts 還 import `idsToRetag` 會讓 tsx 跑不起來，但 vitest 只跑 lib，不受影響；Task 3 立即修）。

- [ ] **Step 5: 先不 commit**——與 Task 3 同一個 commit（刪 `idsToRetag` 會讓 fetch.ts 壞掉，不留中間狀態）。

---

### Task 3: `fetch.ts` 接上 `seen_in`

**Files:**
- Modify: `scripts/fetch.ts`（`Source` 介面、`SOURCES`、`FeedReport`、`reportFeedHealth`、`main` 的 existing/retag/insert 段）

**Interfaces:**
- Consumes: Task 2 的 `memberships` / `ownerOf` / `membershipPatches` / `ExistingRow`。
- Produces: 插入列含 `seen_in: FeedType[]`；job summary 表多一欄 `joined`。

- [ ] **Step 1: `Source` 介面——`authorFeedType` 換成 `search`**

把 `authorFeedType?: Record<string, FeedType>;` 及其 docstring 刪除，改為：

```ts
    /**
     * "Fan = fans" (decision 2026-10-11): a hit authored by a known account
     * is filed under that account only and never gets `fan` membership
     * (feedRank.memberships). Storing it under the account at once also
     * keeps the tweet if the official feed is down (codex review
     * 2026-10-10). The kafu search is topical and does not set this: a
     * talent's tweet about 可不 stays in the Kafu tab. Retweets are
     * unaffected — their URL is the original author's.
     */
    fansOnly?: true;
```

刪除 `const OFFICIAL_AUTHORS = …` 行；`SOURCES` 內兩個 fan feed 的 `authorFeedType: OFFICIAL_AUTHORS,` 改成 `fansOnly: true,`；kafu feed 的 `authorFeedType: OFFICIAL_AUTHORS,` 整行刪除。import 行改為：

```ts
import { memberships, membershipPatches, ownerOf, type FeedType } from './lib/feedRank';
```

- [ ] **Step 2: `FeedReport` 加 `joined`，summary 表加欄**

```ts
interface FeedReport {
    name: string;
    entries: number;
    dropped: number;
    inserted: number;
    retagged: number;
    joined: number;
    newestIso: string | null;
    warnings: string[];
}
```
`reportFeedHealth` 的表頭改為 `'| feed | entries | dropped | new | retagged | joined | newest | warnings |'`、分隔列 `'| --- | --: | --: | --: | --: | --: | --: | --- |'`、資料列在 `${r.retagged}` 後插入 `| ${r.joined} `。`main` 內 `row` 初始化加 `joined: 0`。

- [ ] **Step 3: 重寫 `main` 內從 `const typeOf` 到 insert 的段落**

把 `const typeOf = …` 改成：

```ts
            const typesOf = (e: RssEntry): FeedType[] => memberships(source.feedType, tweetAuthor(e.externalId), !!source.fansOnly);
```

把從 `const { data: existing, error: exErr }` 到 `console.log(\`  ${source.name}: retagged …\`); }` 的整段換成：

```ts
            const externalIds = relevant.map((e) => e.externalId);
            const { data: existing, error: exErr } = await db
                .from('kaf_posts')
                .select('external_id, feed_type, seen_in')
                .in('external_id', externalIds);
            if (exErr) throw new Error(`Select existing failed: ${exErr.message}`);

            // Entries resolve to different membership sets (known authors), so
            // group existing rows by set before computing patches.
            const typesById = new Map(relevant.map((e) => [e.externalId, typesOf(e)]));
            const byTypes = new Map<string, { types: FeedType[]; rows: ExistingRow[] }>();
            for (const ex of existing ?? []) {
                const types = typesById.get(ex.external_id) ?? [source.feedType];
                const key = types.join(',');
                const g = byTypes.get(key) ?? { types, rows: [] };
                g.rows.push(ex);
                byTypes.set(key, g);
            }
            for (const { types, rows: rowsOfTypes } of byTypes.values()) {
                for (const { ids, patch } of membershipPatches(types, rowsOfTypes)) {
                    const { error: upErr } = await db.from('kaf_posts').update(patch).in('external_id', ids);
                    if (upErr) throw new Error(`Membership update failed: ${upErr.message}`);
                    row.joined += ids.length;
                    if (patch.feed_type) row.retagged += ids.length;
                    console.log(`  ${source.name}: ${ids.length} rows -> seen_in ${JSON.stringify(patch.seen_in)}${patch.feed_type ? ` (owner ${patch.feed_type})` : ''}`);
                }
            }
```
import 加 `type ExistingRow`（與 feedRank 其餘 import 同行）。

insert 的 `rows` map 內 `feed_type: typeOf(e),` 改成：

```ts
                feed_type: ownerOf(typesOf(e)),
                seen_in: typesOf(e),
```
後面 `overridden` 統計行維持（`r.feed_type !== source.feedType` 仍成立）。

- [ ] **Step 4: 型別檢查 + 測試**

Run: `pnpm exec tsc --noEmit && pnpm test`
Expected: tsc 無輸出、vitest 全綠。

- [ ] **Step 5: 實跑 fetch（本地 .env）**

Run: `pnpm run fetch 2>&1 | tail -40`
Expected：每個 feed 正常；首輪 `joined` 可能 >0（視窗內 timeline 列補 `official`／成員歸屬——例如 rim 時間軸上的花譜轉推會補 `official`），`retagged` 應 ≤ 個位數；`Done. Total new posts: N`。再用 MCP 驗證：

```sql
select feed_type, seen_in, count(*) from kaf_posts where fetched_at > now() - interval '10 minutes' group by 1,2 order by 3 desc;
select count(*) from kaf_posts where seen_in = '{}';
```
Expected：新列的 `seen_in` 都非空且含 `feed_type`；第二句 = 0（CHECK 保證；若非 0 表示 migration 沒套到，停下）。

- [ ] **Step 6: Commit + push（ingest）**

```bash
cd /home/cholate/kaf-posts-ingest && git add scripts/lib/feedRank.ts scripts/lib/__tests__/feedRank.test.ts scripts/fetch.ts && git commit -m "feat(fetch): seen_in multi-membership; known authors own their search hits" && git push
```
接著重新啟用寫入端並立刻跑一次新版，確認 CI 環境也通：

```bash
gh workflow enable Ingest && gh workflow run Ingest && sleep 90 && gh run list --limit 1 --json status,conclusion,headSha --jq '.[0]'
```
Expected：`conclusion: success`、`headSha` = 剛 push 的 commit。之後 Cloud Scheduler 每小時 :15 照常。

---

### Task 4: observatory——`Post.seen_in`、`POST_COLUMNS`、兩條 API 改包含篩選

**Files:**
- Modify: `/home/cholate/kaf-observatory/src/lib/reader/types.ts:14`（`feed_type` 下一行）
- Modify: `/home/cholate/kaf-observatory/src/lib/reader/constants.ts:5-8`
- Modify: `/home/cholate/kaf-observatory/src/app/api/reader/posts/route.ts:57`
- Modify: `/home/cholate/kaf-observatory/src/app/api/reader/posts/latest/route.ts:56`

**Interfaces:**
- Produces: `Post.seen_in: string[]`；API 查詢參數 `feed_type=<tab>` 語意 = `seen_in @> {tab}`。

- [ ] **Step 1: `types.ts`** 在 `feed_type: string;` 後加：

```ts
  // Every feed that saw this tweet (an official retweet of a talent's tweet
  // is in both). Tabs filter on containment server-side; feed_type is the
  // single owner the ingest worker uses for translation priority.
  seen_in: string[];
```

- [ ] **Step 2: `constants.ts`** `POST_COLUMNS` 的 `"published_at, fetched_at, created_at, feed_type, "` 改為 `"published_at, fetched_at, created_at, feed_type, seen_in, "`。

- [ ] **Step 3: 兩條 route** 把 `if (feedType) query = query.eq("feed_type", feedType);` 改為：

```ts
  // `feed_type` param is the tab id; a row shows in every tab that saw it
  // (kaf_posts.seen_in, migration 0008), not only in its owner tab.
  if (feedType) query = query.contains("seen_in", [feedType]);
```
（兩檔各一處，註解兩檔都放。）

- [ ] **Step 4: 本地驗證 API**

Run: `cd /home/cholate/kaf-observatory && pnpm dev` 另開殼：
```bash
curl -s 'http://localhost:3000/api/reader/posts?feed_type=official&limit=3' | head -c 600
curl -s 'http://localhost:3000/api/reader/posts?feed_type=rim&limit=3' | grep -o '"seen_in":\[[^]]*\]' | head
```
Expected：第一條回 3 列、每列含 `"seen_in":[...]` 且含 `"official"`；第二條回的列 `seen_in` 都含 `"rim"`，且其中應包含 2 列 `feed_type":"official"`（花譜轉推理芽——跨分頁的實證）。

- [ ] **Step 5: 先不 commit**（與 Task 5–6 同一個 feature commit；Task 7 才 push）。

---

### Task 5: observatory——`retweetedInto` 純函式 + `tweetAuthor`

**Files:**
- Create: `/home/cholate/kaf-observatory/src/lib/reader/tweetAuthor.ts`
- Create: `/home/cholate/kaf-observatory/src/lib/reader/retweet.ts`
- Test: `/home/cholate/kaf-observatory/src/lib/reader/__tests__/retweet.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function tweetAuthor(url: string): string | null;                 // lowercase handle, null for /i/status
  export const TAB_RETWEET: Record<string, { accounts: readonly string[]; label: string }>;
  export function retweetedInto(externalId: string, feedType: string): string | null; // label or null
  ```

- [ ] **Step 1: 寫失敗測試**

```ts
// src/lib/reader/__tests__/retweet.test.ts
import { describe, it, expect } from "vitest";
import { retweetedInto } from "../retweet";
import { tweetAuthor } from "../tweetAuthor";

describe("tweetAuthor", () => {
  it("returns the lowercase handle from a status URL", () => {
    expect(tweetAuthor("https://x.com/RIM_virtual/status/1")).toBe("rim_virtual");
    expect(tweetAuthor("https://twitter.com/kaf_info/status/1?s=20")).toBe("kaf_info");
  });
  it("returns null for the anonymous /i/status form and non-status URLs", () => {
    expect(tweetAuthor("https://x.com/i/status/1")).toBeNull();
    expect(tweetAuthor("https://example.com/x")).toBeNull();
  });
});

describe("retweetedInto", () => {
  it("official tab: a tweet by a non-official author was retweeted in", () => {
    expect(retweetedInto("https://x.com/RIM_virtual/status/1", "official")).toBe("KAF");
  });
  it("official tab: tweets by either official account are not retweets, even kaf_info retweeting virtual_kaf", () => {
    expect(retweetedInto("https://x.com/virtual_kaf/status/1", "official")).toBeNull();
    expect(retweetedInto("https://x.com/kaf_info/status/1", "official")).toBeNull();
  });
  it("anonymous author never shows the badge", () => {
    expect(retweetedInto("https://x.com/i/status/1", "official")).toBeNull();
  });
  it("search tabs (fan/kafu) have no accounts and never show the badge", () => {
    expect(retweetedInto("https://x.com/RIM_virtual/status/1", "fan")).toBeNull();
    expect(retweetedInto("https://x.com/virtual_kaf/status/1", "kafu")).toBeNull();
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd /home/cholate/kaf-observatory && pnpm test -- retweet`
Expected: FAIL，找不到模組 `../retweet`。

- [ ] **Step 3: 實作**

```ts
// src/lib/reader/tweetAuthor.ts
// rss.app's <link> is the tweet's own URL, so the author is the first path
// segment. "/i/status/…" is X's anonymous form. Mirrors
// kaf-posts-ingest scripts/lib/tweetAuthor.ts.
const STATUS_URL_RE = /^https?:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]+)\/status\/\d+/;

export function tweetAuthor(url: string): string | null {
  const handle = STATUS_URL_RE.exec(url)?.[1];
  return handle && handle !== "i" ? handle.toLowerCase() : null;
}
```

```ts
// src/lib/reader/retweet.ts
import { tweetAuthor } from "./tweetAuthor";

// Account tabs: which X handles (lowercase) the tab is the timeline of, and
// how the tab is named in the "<label> retweeted" line. Search tabs (fan,
// kafu) are absent on purpose — a search hit is never a retweet into the
// tab. Keep in sync with kaf-posts-ingest feedRank.ts KNOWN_AUTHORS.
export const TAB_RETWEET: Record<string, { accounts: readonly string[]; label: string }> = {
  official: { accounts: ["virtual_kaf", "kaf_info"], label: "KAF" },
};

/**
 * A row in an account tab whose author is not one of the tab's accounts got
 * there by being retweeted (rss.app links retweets to the original tweet).
 * Returns the label to show, or null. Replaces the old `RT by @…:` title
 * prefix check, which broke once rows could enter a tab via another feed.
 */
export function retweetedInto(externalId: string, feedType: string): string | null {
  const tab = TAB_RETWEET[feedType];
  if (!tab) return null;
  const author = tweetAuthor(externalId);
  if (!author) return null;
  return tab.accounts.includes(author) ? null : tab.label;
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `pnpm test -- retweet`
Expected: PASS，6 tests。

---

### Task 6: observatory——`PostCard` 用 `retweetedInto`，`feedType` 穿透 PostFeed／GroupedPostCard

**Files:**
- Modify: `/home/cholate/kaf-observatory/src/components/reader/PostCard.tsx`（整檔）
- Modify: `/home/cholate/kaf-observatory/src/components/reader/TweetPost.tsx:61-73,173-184`
- Modify: `/home/cholate/kaf-observatory/src/components/reader/PostFeed.tsx:11-25,58-60`
- Modify: `/home/cholate/kaf-observatory/src/components/reader/GroupedPostCard.tsx:47,94`
- Modify: `/home/cholate/kaf-observatory/src/components/reader/FeedPage.tsx`（`<PostFeed>` 加 prop）

**Interfaces:**
- Consumes: Task 5 `retweetedInto`。
- Produces: `PostCard({ post, feedType, nav })`、`PostFeed({ …, feedType })`、`GroupedPostCard({ group, feedType })`；`TweetPost` 的 prop `retweetedBy: string | null` 語意改為「顯示的 label」（名字保留，少改一處）。

- [ ] **Step 1: `PostCard.tsx` 整檔**

```tsx
import type { Post } from "@/lib/reader/types";
import type { ReactNode } from "react";
import { TweetPost } from "./TweetPost";
import { retweetedInto } from "@/lib/reader/retweet";

export function PostCard({ post, feedType, nav }: { post: Post; feedType: string; nav?: ReactNode }) {
  return (
    <TweetPost
      externalId={post.external_id}
      translation={post.translation}
      vocabulary={post.vocabulary}
      grammar={post.grammar}
      retweetedBy={retweetedInto(post.external_id, feedType)}
      nav={nav}
    />
  );
}
```

- [ ] **Step 2: `TweetPost.tsx`** 把 `retweetedBy` 的註解（68–72 行）換成：

```ts
  // Non-null → this card is in the tab because one of the tab's accounts
  // retweeted it (author ∉ tab accounts, see lib/reader/retweet.ts). The
  // value is the tab's label; it renders as the first child of the
  // TweetContainer (mimicking X's native retweet header) the moment
  // react-tweet resolves the tweet body.
```
184 行 `<span>@{retweetedBy} retweeted</span>` 改為 `<span>{retweetedBy} retweeted</span>`。

- [ ] **Step 3: `PostFeed.tsx`** props 加 `feedType: string;`（型別與解構都加），58–60 行改：

```tsx
            <GroupedPostCard key={item.id} group={item} feedType={feedType} />
          ) : (
            <PostCard key={item.id} post={item.post} feedType={feedType} />
```

- [ ] **Step 4: `GroupedPostCard.tsx`** 47 行簽名改 `export function GroupedPostCard({ group, feedType }: { group: PostGroup; feedType: string })`；94 行 `<PostCard` 加 `feedType={feedType}`。

- [ ] **Step 5: `FeedPage.tsx`** `<PostFeed` 加 `feedType={feedType}`。

- [ ] **Step 6: 全專案檢查**

Run: `cd /home/cholate/kaf-observatory && pnpm exec tsc --noEmit && pnpm lint && pnpm test`
Expected：三者皆無錯誤。若 tsc 指出其他 `PostCard`／`PostFeed` 呼叫點（計畫未列，例如 `MobileHub.tsx`），補 `feedType` prop（MobileHub 固定 `"official"`），並在回報中列出。

- [ ] **Step 7: 瀏覽器驗證**

`pnpm dev` → 開 Reader overlay：
- KAF 分頁：找一則 `RT by` 標題的列（例如最新的官方轉推），應顯示「KAF retweeted」；kaf_info 轉 virtual_kaf 的列不再顯示 badge（預期改變）。
- Fan 分頁：無 badge；理芽／CIEL 等成員本人的推文不再出現（實測 3 列）。
- Kafu 分頁：如常。

- [ ] **Step 8: Commit（observatory，不 push）**

```bash
cd /home/cholate/kaf-observatory && git add src/lib/reader src/components/reader src/app/api/reader && git commit -m "feat(reader): tabs filter on seen_in; retweet badge from author vs tab accounts"
```

---

### Task 7: 上線順序與補掃

**Files:** 無新檔；SQL 走 MCP。

- [ ] **Step 1: 確認 ingest 新版已在 CI 跑過**

`gh run list --limit 3 --json createdAt,conclusion,headSha` → migration 之後的每個 run 的 `headSha` 都是 Task 3 的 commit 或之後（零次舊 writer run），且 job summary 表有 `joined` 欄。

- [ ] **Step 2: 清理舊 writer 在 migration 之後留下的分類（冪等；observatory 上線前必跑）**

舊 writer 把成員推文存成 `fan/{fan}`、或把官方推文從 kafu retag 成 `official`（trigger 已補 owner）。重跑與 Backfill 2 同語意的 SQL，但保留既有歸屬、只移除 `fan`：

```sql
with a(handle, t) as (values
    ('virtual_kaf','official'), ('kaf_info','official'),
    ('rim_virtual','rim'), ('harusaruhi','harusaruhi'),
    ('isekaijoucho','isekaijoucho'), ('ciel_vanillasky','ciel'))
update kaf_posts p
set feed_type = case when p.feed_type in ('fan','kafu') then a.t else p.feed_type end,
    seen_in   = array_remove(
                  case when p.seen_in @> array[a.t] then p.seen_in else array_append(p.seen_in, a.t) end,
                  'fan')
from a
where lower(split_part(p.external_id, '/', 4)) = a.handle
  and (p.seen_in @> array['fan'] or not p.seen_in @> array[a.t] or p.feed_type in ('fan','kafu'));
```
接著驗證：
```sql
select count(*) filter (where not seen_in @> array[feed_type]) as owner_missing,
       count(*) filter (where seen_in @> array['fan'] and lower(split_part(external_id,'/',4)) in
         ('virtual_kaf','kaf_info','rim_virtual','harusaruhi','isekaijoucho','ciel_vanillasky')) as fan_by_known
from kaf_posts;
```
Expected：兩者皆 0。更新列數通常 0（若 migration 後沒有舊 run）。這段 SQL 也是日後**被迫回滾 ingest** 後的修復程序，記進 LESSONS。

- [ ] **Step 3: push observatory**

```bash
cd /home/cholate/kaf-observatory && git push
```
Vercel 部署後再用線上 URL 重跑 Task 4 Step 4 的兩條 curl（換 host），並開 Reader 看 KAF 分頁。

- [ ] **Step 4: 文件**

- `docs/reader-pipeline-review-2026-10-10.md` §5 多重歸屬條目末尾加一行「Shipped 2026-10-xx（ingest <hash>, observatory <hash>, migration 0008）」。
- ingest `CLAUDE.md` File layout：`scripts/fetch.ts` 描述加「每個 feed 把自己的歸屬併進 `seen_in`」；`scripts/lib/` 列表不變（feedRank 仍在）。
- `docs/LESSONS.md` 加一條：「新增『不在集合 = 不可見』語意的欄位時，DB 端 trigger／CHECK 守住 owner 不變量，剩下的舊 writer 分類殘留用冪等清理 SQL（Task 7 Step 2）而不是靠部署順序；ingest 不回滾到 0008 之前，被迫回滾後重跑清理」（codex 計畫審查 2026-10-11 兩輪 high，RED 收據 = 初稿只靠部署順序）。
- 記憶檔 `next-multi-membership` 改為已完成、下一步 = 粉絲頁伺服器端分組。

```bash
cd /home/cholate/kaf-posts-ingest && git add docs CLAUDE.md && git commit -m "docs: multi-membership shipped" && git push
```

---

## Self-review 紀錄

- Spec coverage：§5 多重歸屬（Task 1/3/4）、標記改作者判定（Task 5/6）、fan = fans（Task 2 memberships search 分支 + Task 1 Backfill 2）、§4 A（Task 2 兩方向測試）、§4 B（設計決定 6）、§4 F（設計決定 1 的 author-own-feed 規則）。未涵蓋且刻意不做：翻譯成員類別、粉絲頁分組、成員分頁。
- Type consistency：`memberships(source, author, search)` / `ownerOf(types)` / `membershipPatches(types, existing)` / `ExistingRow` / `RowPatch` 在 Task 2 定義、Task 3 使用；`retweetedInto(externalId, feedType)` Task 5 定義、Task 6 使用；`feedType: string` prop 名在 PostCard／PostFeed／GroupedPostCard 一致。
- Review Focus 五項各綁到 Task 2 測試 3/4/5、Task 1 Step 4 trigger 實測、Task 4/5 設計。
- codex 計畫審查 round 1（2026-10-11，誤觸無 focus 版）：high「空預設 + rollback 隱形列」→ 設計決定 7；medium「`--help` 會跑 ingest」→ 不採納（fetch.ts 既有行為，與本計畫無關，無人以該方式呼叫）。
- round 7（delta）：medium「Step 5 失敗時還沒有 commit 可 revert」→ 拆成未 push（捨棄本地改動）／已 push（revert）兩句；措辭修正，未再送審。
- round 6（delta）：medium「abort 不涵蓋新 writer 在 Task 3 Step 5/6 寫入的分類」→ 採納 codex 的替代方案：SQL abort 只到新 writer 第一次實跑前，之後回滾是正向資料遷移，明寫不在本計畫內。
- round 5（delta）：high「abort 在 Task 3 push 後會讓新 writer 缺欄位失敗」→ abort 限 push 前；push 後先 disable＋排空＋revert 再 drop；medium「還原硬寫 fan，kafu 列會被誤歸」→ 改用記下的 `(external_id, feed_type)` VALUES 還原。
- round 4（delta）：high「disable 不會排空已 dispatch 的 run」→ 停用後 until 迴圈等 queued/in_progress 歸零再動 DB；medium「abort 的 DROP COLUMN 被 `UPDATE OF` trigger 擋住、函式殘留、回填的 feed_type 沒還原」→ 改成顯式交易（drop trigger → drop function → drop column → 還原 3 列）。
- round 3（delta）：medium「容許的 0–1 次舊 run 若經 kafu feed 看到官方可不推文，事後無法補 kafu」→ 採納，改為硬切換：`gh workflow disable/enable Ingest` 包住 migration→push 區間（gcloud 未安裝，不動 Scheduler）；清理 SQL 降為驗證。
- round 2（帶 focus）：high「trigger 只管 insert；舊 retag 與舊 fan 分類會留殘」→ trigger 改 INSERT OR UPDATE + CHECK owner-containment + Task 7 冪等清理 + 時機／不回滾規則；medium「kafu 是主題分頁，不該套 fan = fans」→ 採納，`fansOnly` 只標兩個 fan feed，Backfill 2 拆成 fan／kafu 兩段。
