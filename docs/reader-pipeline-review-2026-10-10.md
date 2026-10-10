# Reader pipeline — architecture review brief (2026-10-10)

Scope: the X-post path end to end — rss.app feeds → `kaf-posts-ingest`
(`fetch.ts`, `translate.ts`) → Supabase `kaf_posts` → `kaf-observatory` Reader
overlay. Not in scope: `kaf_streams` / ON AIR.

Reviewer brief: this is a design review, not a code review. The user wants an
outside opinion on (1) classification + dedupe rules, (2) presentation / UX,
(3) efficiency, with one hard future requirement: **one Reader tab per
KAMITSUBAKI talent** (理芽, 春猿火, ヰ世界情緒, 幸祜, CIEL — 幸祜 has no feed
yet). Decisions already made by the user and not up for debate are marked
**[fixed]**. Everything else is open; please challenge the premises, not only
the details. Numbers below are measured on the live DB unless marked "est.".

## 1. Current architecture

### 1.1 Sources (rss.app Basic: 15 feeds, 25 items/feed, hourly refresh; 9 used)

| `SOURCES` entry | kind | `feed_type` | gate |
|---|---|---|---|
| @virtual_kaf, @kaf_info timelines | account | `official` | none |
| X search 「花譜」 (Top tab) + same query `f=live` (Latest) | search | `fan` | `mustMatch /花譜\|kaf\|カフ\|可不/i` on the tweet body |
| X search 「可不 kafu」 | search | `kafu` | `mustMatch /可不\|kafu/i` |
| @RIM_virtual, @harusaruhi, @isekaijoucho, @CIEL_VanillaSky timelines | account | `rim` / `harusaruhi` / `isekaijoucho` / `ciel` | none |

Why two fan feeds: two snapshots on 2026-10-10 showed each one missing posts
the other carried (10/28 and 6/31 inside the shared window); misses never
arrived in later runs. rss.app's 25-item window is the bottleneck on burst
days (fan posts/day: median 45, max 84 over the last 25 days).

Talent timelines exist primarily for `streams.ts` (members-only stream
discovery); their rows are **invisible in the Reader today** (no tab) and
**not translated** (`translate.ts` `FEED_PRIORITY = official → kafu → fan`).

### 1.2 Row model and dedupe (`fetch.ts`)

- `kaf_posts`: one row per tweet, `external_id` = tweet URL (UNIQUE),
  single `feed_type TEXT` (no CHECK), `title` keeps rss.app's
  `RT by @handle: …` prefix, `original_text` = description HTML → text with a
  trailing `— @handle Mon D, YYYY` line, `media_urls`, `published_at`, plus
  translation columns (`translation`, `annotated`, `vocabulary`, `grammar`).
- Retweets: rss.app gives the **original** tweet's URL, so a retweet and its
  original are the same row.
- Precedence when several feeds see one tweet (`feedRank.ts`, 2026-10-10):
  `official(3) > talent(2) > kafu(1) > fan(0)`. A higher feed meeting a row a
  lower feed stored first **retags** it (`feed_type` UPDATE). Before this,
  first writer won and 5 official-account tweets sat in the fan tab.
- `authorFeedType` (2026-10-10): the search feeds store tweets *authored by*
  @virtual_kaf / @kaf_info as `official` immediately (author parsed from the
  URL), so they never touch the fan tab and survive an official-feed outage.
- **[fixed]** `official` = only the two 花譜 accounts (incl. their retweets).
  A talent's own tweet about 花譜 stays under the talent's `feed_type` even
  though no tab shows it yet; it will surface in the talent's tab.

Consequence worth reviewing: single-label rows mean a tweet is in exactly one
tab. A @RIM_virtual tweet announcing a 理芽×花譜 collab is found by the fan
search, stored `fan`, then retagged `rim` by the talent feed — it leaves the
fan tab. With talent tabs it appears under 理芽, but a 花譜 fan scrolling the
fan tab will not see it.

### 1.3 Translation (`translate.ts`)

Gemini `gemini-3.5-flash-lite`, ≤10 rows per hourly run (240/day), queue
filled `official → kafu → fan`, newest first. Last 30 days: 62 official, 82
kafu, 1113 fan rows; all translated but 1 (backlog ≈ 0). ≈ US$0.0013/row ⇒
fan translation ≈ US$1.5/month (est.). Output is translation + annotated +
vocabulary + grammar; the Reader uses translation/vocabulary/grammar, **never
`annotated`** (~¼ of output tokens, est.). One row is permanently rejected by
Gemini (`PROHIBITED_CONTENT`) and retried every run.

### 1.4 Reader (`kaf-observatory/src/components/reader`, `src/lib/reader`)

- Three hardcoded tabs: `ReaderOverlay.tsx:35,43,114-116`,
  `ReaderHeader.tsx:27-31` (`TABS`), `FeedPage.tsx:30`. API routes accept any
  `feed_type` string.
- Data: `GET /api/reader/posts?feed_type&limit≤100` (anon key, server
  route, cursor on `(published_at, id)`, CDN `s-maxage=60`); infinite scroll
  stops at **50 posts per tab** (`MAX_TOTAL_POSTS`). `GET …/latest?since`
  polls every 60 s (≤7 days back, `s-maxage=30`) and prepends new rows.
- Rendering: each row is drawn by **react-tweet fetching the live tweet from
  X** using the id from `external_id`. `original_text` / `media_urls` /
  `annotated` are never displayed; `original_text` is used only for grouping.
  Deleted or failing tweets render nothing (silent gap).
- Retweet badge: regex `/^RT by @handle:/` on `title`.
- Author chips (`FilterBar.tsx`): handle parsed from the URL, counts over the
  loaded posts, top 5 + "+N more", click = mute that author; mute state is
  in-memory and resets on tab switch. Fan tab last 30 days: 700 distinct
  authors, 77% posted once, top author 21 posts — so chips rarely help there.
- Grouping (`groupPosts.ts`): same author, within 24 h, trigram overlap ≥0.4
  on `original_text` (URLs stripped) → "N similar posts" stack. Cross-author
  near-duplicates ("XX好好聽", 23×`#花譜美術部`, 15×「おつかれSUMMER」 covers)
  are not grouped — by design today.
- Translate toggle (文A) persisted in localStorage; untranslated rows show no
  panel and no placeholder.
- No read-state / "new since last visit"; no sorting in the browser.
- Tests: paging, mergePosts, translateMode, quotedTweetStore. Untested: API
  routes, `groupPosts`, `FilterBar`, retweet regex, hooks.

### 1.5 Health / ops

Hourly GitHub Actions run (Cloud Scheduler dispatch). Per-feed health goes to
run annotations + job-summary table only (**[fixed]**: no red runs, no mail —
user refuses noisy alerts). Retag counts are in the same table.

## 2. Candidate changes (author's own list, with the author's lean)

The reviewer is asked to rank these, kill the bad ones, and add what is
missing.

1. **Per-talent tabs** (committed future work). Minimal: extend the `Feed`
   union, `TABS`, the `FeedPage` lines, and add the talent types to
   `FEED_PRIORITY` (else no translation ⇒ no panel). Open questions: tab
   order/naming; whether chips/mute make sense on a single-account tab (the
   only distinct authors are retweet originals); whether a talent tab should
   also show the talent's retweets (today yes — same row model). Lean: do it,
   small.
2. **Single-label vs multi-label rows.** Options: (a) keep single label +
   precedence (today); (b) `feed_types TEXT[]` = every feed that saw the row,
   tabs filter with `@>`; (c) keep single `feed_type` but add a second column
   `seen_in TEXT[]` so the fan tab can *also* show rows whose `seen_in`
   contains `fan` even if the owner is a talent. Lean: (c) is the least
   disruptive if cross-tab visibility is wanted at all; otherwise (a). The
   author is unsure cross-tab visibility is worth the extra concept.
3. **Fan-tab burst handling.** 50-post cap vs 45–84 posts/day means the fan
   tab shows roughly one day. Options: raise the cap (cheap, more react-tweet
   fetches), cross-author grouping by shared hashtag or by linked YouTube
   id (e.g. all 「散歩の邪魔」 reactions as one stack), or a "today / this
   week" split. Lean: hashtag/link grouping is the only one that reduces
   repetition rather than hiding it.
4. **Author chips on the fan tab are near-useless** (77% single-post
   authors). Replace with hashtag chips, or keep chips but default to
   hashtags on search-backed tabs. Lean: try hashtag chips; keep mute.
5. **Persist mutes** (localStorage, per tab). Lean: yes, trivial.
6. **Translation scope.** Drop `annotated` from the Gemini schema (never
   rendered) to cut output tokens ~¼ (est.); or translate fan rows lazily on
   first open. Lean: drop `annotated`; lazy translation adds a write path to
   the web and is not worth US$1.5/month.
7. **Silent gaps from deleted tweets.** react-tweet renders nothing; the row
   still counts toward the 50 cap and chip counts. Options: fall back to
   `original_text` + `media_urls` (we store them) or filter client-side.
   Lean: fall back to stored text — the data is already there.
8. **Permanent translation failures** (`PROHIBITED_CONTENT`): mark the row
   (e.g. `translation = ''` or a `translate_error` column) so it leaves the
   queue. Lean: yes, tiny.
9. **rss.app side.** Keyword blacklist cannot fix semantic duplicates; the
   25-item window cannot be raised on Basic. Nothing to do there beyond what
   is done. Lean: leave.
10. **Efficiency.** Ingest does 9 feed fetches + 9 `IN` selects + ≤9 inserts
    per hour; translate ≤10 Gemini calls; the Reader's cost centre is
    react-tweet's live fetches (one per visible post). Nothing here looks
    worth optimising at this scale. Lean: confirm or refute.

## 3. Questions for the reviewer

- Is the single-`feed_type` + precedence model sound once there are 8 tabs,
  or is it already the wrong primitive (see §1.2 consequence)?
- Given react-tweet renders live, is storing `original_text`/`media_urls` and
  translating *every* fan post still the right trade, or should the pipeline
  shrink to ids + classification and translate on demand?
- What would you remove from the current design? What is the one change with
  the best value/effort ratio before the talent tabs ship?
- Any failure mode in the precedence/retag path you can construct that would
  misfile an official post or lose one?

## 4. Review outcome (codex adversarial review, 2026-10-10) and verification

Codex verdict: needs-attention. Findings, each checked against the live DB
(3973 rows) the same day:

| # | Codex finding | Verified? | Weight |
|---|---|---|---|
| A | Single-label + precedence contradicts the fixed semantics: an official retweet of a talent's tweet retags `rim` → `official`, so it leaves the talent tab. Two talents retweeting one tweet: first feed wins. | **Real.** 2 such rows exist (@RIM_virtual tweets retweeted by 花譜, 2026-08-21 and 09-12). | high — the only structural issue; blocks talent tabs |
| B | Retag updates `feed_type` only, so a fan-stored original later claimed by the official feed keeps the fan title and loses the "retweeted" badge. | **Real.** 1 of 76 official rows by other authors lacks the `RT by` prefix today; will grow now that retag is live. | medium, cheap fix (update `title` too) |
| C | `external_id` is the raw URL, so `x.com/…` vs `twitter.com/…?s=20` would be two rows and bypass precedence. | **Theoretical today.** 0 non-`x.com` URLs, 0 query strings, 1 duplicate tweet id in 3973 rows. rss.app emits one canonical form. | low; revisit if rss.app changes its URL form |
| D | Translation queue starvation: `shouldSkip` residue and failures stay NULL inside the "newest 50 per feed" window and can block older rows. | **Not happening.** 20 NULL rows total, all Jul–Sep short/non-Japanese or the one `PROHIBITED_CONTENT` row; none inside any feed's newest-50 window. | low; an explicit status column is still the clean fix |
| E | Client-side grouping cannot extend the fan tab's reach (50-row cap is applied before grouping). | **Correct by construction** (`usePosts.ts:40-53`). | medium — reshapes candidate 3 |
| F | Retag error is swallowed per source; if the item leaves the 25-item window before a retry, the lower label is permanent. | Correct by construction; not observed. | low |

Codex ranking of §2: #7 (stored-text fallback for deleted tweets) first for
value/effort; #2 only as true multi-membership and before #1; #6 keep
(drop `annotated`), kill lazy translation; #8 keep with an explicit state;
#3 rework (group server-side or page until N groups); #4 rework toward
event/link facets, no chips on single-account tabs; #5 defer; #9/#10 keep.

Agreed with codex: keep eager translation and the stored snapshot; drop
`annotated`. Disagree on urgency of C and D (data says no).

## 5. User decisions (2026-10-10, same day)

- **Multi-membership: yes.** An official retweet of a talent's tweet shows in
  the KAF tab *and* the talent's own tab (same row — rss.app links retweets
  to the original URL). Model: `seen_in TEXT[]` of feeds that saw the row;
  tabs filter by containment; "retweeted" badge derived from author ≠ the
  tab's account, not from the title prefix. Prerequisite for talent tabs.
- **Deleted tweets: never render stored text** (respect the author's
  removal). Candidate 7 killed; only the "still counts toward the 50-row
  cap" nit remains, low priority.
- **`annotated` dropped** from the Gemini schema (confirmed unused in
  `TranslatePanel.tsx`). Shipped.
- **Pre-filter before translation**: strip the attribution line, skip
  tag/link/mention-only rows (`translateInput.ts`). Shipped.
- Fan-tab grouping by linked YouTube id / hashtag, server-side, and no
  author chips on single-account tabs: agreed in principle; after
  multi-membership.
