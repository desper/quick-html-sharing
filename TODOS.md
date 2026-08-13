# TODOS

## Worker

### R2 binding 若支援 versionId 就重新評估自管版本 key

**What:** 追蹤 Cloudflare 是否在 Workers R2 binding 上暴露 `versionId`。若有，版本歷史的自管邏輯（`lib/objectKey.ts` 的 v{n} key 佈局、retention sweep、孤兒回收）可能拿掉一大半。

**Why:** 這次為了繞過 binding 限制寫了相當多機制。典型的「平台補上了就該刪程式碼」債務，不記就永遠不會回頭看。

**Context:** 2026-08-09 plan-eng-review 查證：R2 object versioning 已 GA，但 Workers binding 的 `get`/`put`/`head`/`list`/`delete` 都沒有 versionId 參數，要讀特定版得在 Worker 內自簽 SigV4 走 S3 API。第二個阻礙是 R2 versioning 的 retention 是 bucket 層級 lifecycle 規則，管不到 per-share「保留最近 N 版」。**兩個阻礙要同時消失才值得換。** 起點：`lib/objectKey.ts` 的註解已記錄這個結論。

**Effort:** S（評估）/ M（若真的換掉）
**Priority:** P4
**Depends on:** 版本歷史出貨後 + CF 平台變化

### retention sweep 改用前驅鏈判斷保留範圍

**What:** 讓 retention sweep 也走 `prev` 前驅鏈，保留「真正提交過的最近 10 版」，並主動收掉不在鏈上的幽靈物件。目前 sweep 是數物件個數，列表與 restore 是走鏈。

**Why:** 兩處對「版本」的定義不完全一致，是刻意的取捨而不是 bug —— 下一個讀 `cleanup.ts` 的人若不知道，會往「修正不一致」的方向改，然後付出走鏈的成本。幽靈物件會佔掉 10 個保留名額裡的位子，若幽靈變常見，使用者能救回的真實版本數會默默少於 10。

**Context:** 2026-08-11 plan-eng-review 的 T1。原本的 sweep 用 `latest_version - RETENTION_VERSIONS + 1` 這個純算術算保留線，版號一跳號就會提早刪掉真實歷史（codex outside voice 抓到）。當時裁定改成「版號降序數第 10 個物件」——零額外 R2 呼叫，用的是 sweep 已經 list 到手的同一份清單。走鏈才是完全正確的答案，但要 50 shares × 10 次 head，每十分鐘一輪，在幽靈罕見的前提下不值得。**觀察點：版本列表筆數是否經常少於該 share 實際的物件數。** 若開始經常少，前提就失效了。

**Effort:** M
**Priority:** P4
**Depends on:** T1 出貨 + 實際觀測到幽靈頻率

### 刪除後的完整 stats 實務上取不到

**What:** 釐清「share 刪除後 stats 仍可讀」這個承諾要不要算數，還是只對存過 sync code 的人成立。

**Why:** `routes/edit.ts:130` 寫明刪除只是 tombstone、「它的 stats 保持可讀」，而伺服器確實保留了 `edit_token_hash`。但三個客戶端在刪除成功後都立刻抹掉本機的 edit token 記錄（`edit.astro:105`、MCP `index.ts:211`）。所以一個沒存過 sync code 的 share 被刪除後，授權資料還在伺服器上，卻沒有任何客戶端拿得出鑰匙 —— 文件描述的能力沒有入口。

**Context:** 2026-08-11 plan-eng-review 的 codex outside voice 抓到。D2 把 referrers/locations/uniqueViewers/dailyViews 移到憑證層之後，這句承諾對完整數據來說幾乎沒有實際意義。三種可能的收法：(1) 刪除前提醒使用者可以先看一次完整數據；(2) 刪除時不抹本機 token、只標記已刪；(3) 承認這個承諾只對有 sync code 的人成立，把註解改準。三種各有產品含意 —— 這是「刪除後的數據還值多少」的產品問題，不是工程問題。這也是 `ui-draws-undelivered-api` 那條 learning 的又一次出現：API 有能力，UI 沒入口。

**Effort:** S
**Priority:** P4
**Depends on:** D2 出貨

### D19 跨裝置 edit 限制重新檢視

**What:** 觀察「還原能跨裝置但 edit 不能」這個不對稱是否造成困惑，出現訊號再評估 v2 vault。

**Why:** 版本歷史出貨後，使用者在 B 電腦（只有 sync code）可以把內容換成舊版，卻不能貼一份新的上去。這個界線在產品上不直觀。

**Context:** D19 出自 2026-06-13 plan-design-review（「無本機 token 不渲染 edit，v2 vault 才解」）。2026-08-09 的 D5 以「還原不需要內容知識，風險模型與 edit 不同」為由擴張了一次邊界，並補上 MCP/skill 的 sync key 路徑 —— 那正是跨裝置操作的地基。要再擴到 edit 就是 vault 問題（client-side 加密的 edit token 儲存），`shares` 已預留 `vault_ciphertext` / `vault_updated_at` 欄位。觀察點：有沒有人問「為什麼我能還原卻不能編輯」。

**Effort:** S（觀察）/ L（若做 vault）
**Priority:** P4
**Depends on:** 版本歷史出貨後有實際使用

### 多 sync key 綁定觀察

**What:** 觀察「一條 share 需綁定多把 sync key」（多人協作、換 key、多裝置不同 key）的真實需求，出現訊號再設計 `share_owners` 多對多表。

**Why:** v1 維持單一 `owner_key_hash`（plan-eng-review T3 裁決）；換 key 使用者靠「claim 過戶」覆蓋，但撞到 `owned-by-other` 的人體驗就是被拒絕。先收資料再設計，避免提前建多對多表。

**Context:** 2026-06-12 plan-eng-review T3 / Codex outside-voice #4。觀察點：`POST /api/my-shares/claim` 回 `owned-by-other` 的頻率（可從 worker telemetry 計數）。design doc「NOT in scope」段有對應 bullet。若頻率顯著，再評估多 key 模型（share_owners 表 + claim 語意改「加入」而非「過戶」）。

**Effort:** S（觀察）/ L（若真做多 key）
**Priority:** P4
**Depends on:** PR1 上線後有 claim 流量

## Web

### 設計系統 consultation（字體決策 + DESIGN.md 建立）

**What:** 為 qhs.fyi 做一次正式的設計系統決策：①字體/品牌調性，取代 `global.css` 的系統預設字體串（`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto`）；②建立 DESIGN.md，把 de facto 設計系統（global.css 變數 + 首頁慣例）與 My Shares 新增的 4 個 pattern（amber notice box、claim banner、text input、checkbox confirm gate）正式入冊。

**Why:** 2026-06-13 plan-design-review（My Shares PR2）期間，codex outside-voice 判定 default font stack 為 AI-slop 特徵（slop blacklist #11）——等於沒做過字體決策。但這是全站既有樣式，不該由功能 PR 順手換（品牌層級決策），也不能默默吞掉警告。

**Context:** D13 裁決：defer 至 /design-consultation 全站一次解（字體、配色、品牌調性一起）。起點：`apps/web/src/styles/global.css` 的 `font:` 宣告。注意 system font 有正當理由（零載入成本、原生感）——consultation 的結論也可能是「刻意保留」，但要是個有記錄的決策。

**Effort:** S（決策）+ S（實作）
**Priority:** P3
**Depends on:** 無（任何時候可跑 /design-consultation）

### v2 glanceable view counts（denormalized counter）

**What:** `shares` 表加 `view_count` 欄（view 寫入路徑順手 +1），`GET /api/my-shares` 回傳 view count，My Shares 列表 row 恢復 glanceable 數據。

**Why:** 2026-06-13 plan-design-review D18 裁決：列表 views badge 違反 eng-review API 契約（不含 view count，避免每次列表載入跑聚合查詢）而拿掉，v1 靠 stats 連結。但「一眼掃出哪條最熱」對主打 viewer analytics 的產品是合理 v2 升級。

**Context:** 做法是 denormalized counter（非查詢時聚合），列表零額外成本；改 API 契約 + view 寫入路徑屬架構變更，**需重跑 /plan-eng-review**。觀察點：My Shares 上線後是否有用戶要列表看數據的訊號。

2026-08-08 補充：這條現在同時是**成本問題**，不只是 UI 升級。stats endpoint 的 `COUNT(*)` / `COUNT(DISTINCT ip_hash)` 隨 view 數線性成長（D1 按 rows_read 計費），而 `views` 沒有列級 retention——2026-08-08 那輪只讓 raw ua/referrer 過期匿名化，列本身永久保留。熱門 share 每次開 stats 都在全掃自己的 view 歷史。denormalized counter 同時解掉列表 UI 與這個掃描成本，是同一個改動；`is_bot` 已在 schema 裡，counter 要拆 human/bot 兩欄。

**Effort:** M
**Priority:** P4（UI）/ P2（成本，若 view 量起來）
**Depends on:** My Shares PR1-3 出貨後 + 用戶訊號

### 全站 a11y 基線套用（首頁 + stats 頁）

**What:** 把 My Shares 的五條 a11y 基線（aria-live 結果訊息、原生 label 關聯、disabled 說明、`:focus-visible` 描邊、contrast ≥ 4.5:1）套用到既有首頁（dropzone 鍵盤操作、result panel）與 stats 頁。

**Why:** 2026-06-13 plan-design-review D17 裁決：PR2 只規範 My Shares 頁，全站審查超出範圍。但首頁有同類問題（無 :focus-visible、dropzone 鍵盤未驗證、結果訊息無 aria-live），基線已定義好，套用成本低。

**Context:** 基線定義在 design doc「A11y 基線（D17 裁決）」段。非 WCAG 全面審查，只套五條。

**Effort:** S
**Priority:** P4
**Depends on:** My Shares PR2 出貨後（基線 pattern 先在新頁落地）

## Completed

### Viewer location：country 與 city（2026-08-10）

`views` 加 `country` / `city`，值取自 Cloudflare 每個請求已經解好的 `request.cf` —— 沒有 GeoIP 查詢、沒有第三方、沒有額外延遲。

**無法回填。** 唯一能推出位置的欄位是 IP，而那存的是加鹽單向雜湊，所以 0006 之前的 2400 筆瀏覽永遠沒有位置。上線那一刻就是資料的分水嶺。

隱私邊界刻意跟 `ua`/`referrer` 對齊：位置至少一樣可識別個人，所以四個欄位在 90 天時被同一條 UPDATE 一起清空，刪除 share 時也一起立刻清。過程中發現 0004 的 partial index 只認得 ua/referrer —— 一筆「沒有 User-Agent 但有城市」的瀏覽會落在索引外、永遠掃不到，0006 一併重建。

`label`（`Taipei, TW` / `TW` / `unknown` / `other`）在伺服器端算好，三個 surface 才不會對同一列漂出三種渲染；「解出國家但沒解出城市」這個常見情況的規則也只需要決定一次。

測試方式是 referrer bug 的直接產物：第一條測試注入 `request.cf` 走**真實 renderer** 再從 stats 讀回來，因為寫入端和讀取端各自對自己的格式是對的、卻可能彼此不一致，而分開測抓不到。

### MCP / skill 跨裝置補完（2026-08-10）

`qhs_list` 只讀本地 store、`qhs_delete` 沒有本機 editToken 就放棄 —— 兩個都不是伺服器的限制，`/api/my-shares` 一直都在，DELETE 也一直吃 sync key bearer。是 client 從來沒去問。

列表改成**聯集而非取代**：sync code 存檔之前建立的 share 伺服器端 `owner_key_hash` 是 NULL，把遠端當唯一真相會讓工具「弄丟」本來列得出來的東西。

delete 的確認閘門只加在走 sync key 那條 —— 握有 edit token 本身就是「你指的是這一個」的證據，換成 sync code 之後一個裸 slug 就足以刪掉任何機器上的任何 share。在有本機 token 那條加必填確認會打斷今天就能用的呼叫端，換不到安全性。

`packages/mcp` 從零自動測試變成有測試（判斷邏輯抽進 `src/shares.ts` 才測得到 —— `index.ts` 在模組頂層就 connect stdio transport）。npm 發佈到 0.4.0。

### 版本歷史：edit 不直接覆寫（2026-08-09）

`POST /api/edit/:slug` 不再覆寫 R2，改為附加新版本，加上版本列表 / 原始碼預覽 / 還原三個端點。誤蓋現在救得回來。

原案的 `share_versions` 表**被否決**：R2 `list()` 回傳的 `uploaded`/`size` 已經是同一份資料，在沒有交易的 R2+D1 邊界上維持兩個真相來源必然漂移。改為 `shares` 加三欄。

- **`latest_version`** — 純單調計數器。還原寫成新版本而不是搬指標，所以沒有「目前版本」狀態機可以壞掉，也讓還原本身可逆。
- **`versions_pruned_below`** — 讓 retention sweep 會收斂。原本的 `latest_version > N` 因為計數器只增不減，一個 share 跨過門檻後就永遠符合條件，配上單輪上限會讓同一批 share 每十分鐘重掃、後面的餓死。
- **`orphan_since`** — 計畫外的第三欄，QA 時才發現：孤兒回收原本掛在 retention 門檻底下，只有兩三個版本的 share 永遠掃不到自己的孤兒。

key 佈局：v1 沿用 pre-versioning 的 flat key（零資料遷移、讀路徑不需要 fallback），v2+ 走 prefix。`htmlObjectKey` 的 `version` 參數刻意沒有預設值——漏傳會是編譯錯誤，不是安靜地覆蓋 v1。

並行寫入用 R2 conditional put（`etagDoesNotMatch: '*'`）搶版號 + D1 CAS 提交。QA 用 5 個並行 edit 打真實 worker 時抓到：CAS 輸家的物件會以合法版本身分留在歷史裡，而 sweep 只認得 `version > latest_version` 的孤兒，後續寫入會把 latest_version 推過那個號碼。改成輸家立刻刪掉自己的 key——安全的前提正是 conditional create 讓那個 key 只可能屬於它自己。

QA 另外抓到一個 P0：commit 前最後一次 `biome --write` 把四個 `.astro` 頁面的 `import Base` 當成死程式碼刪掉，`/edit`、`/my-shares`、`/stats`、`/versions` 全部 500。`astro build` 照樣報「6 pages built」成功，只有 `astro check` 會抓到。已在 `biome.json` 對 `**/*.astro` 關掉 `noUnusedImports`。

E2E 覆蓋四條 critical path（誤蓋救回 / 跨裝置救回 / 預覽先於曝光 / 並行不丟資料）+ 409 時編輯框不清空。playwright.config 多起一個 share-role worker，因為「收件人看到還原後的內容」是另一個 process 讀同一份 R2/D1 的宣稱。

設計與審查記錄：`~/.gstack/projects/desper-quick-html-sharing/lijianchang-chat-8fd9186a-design-20260808-235816.md`

### viewer analytics 補完（2026-08-08）

review 發現 `views` 表存了 `ip_hash` / `ua` / `referrer` 三欄但 stats 只跑 `COUNT(*)` + `MAX(viewed_at)`——資料收了沒用，README 賣的 "viewer analytics" 實際只是一個計數器。四步補完：

1. **unique viewers + referrer breakdown + stats 測試**：`ShareStats` 加 `uniqueViewers`、`referrers`（hostname 正規化，top 5 + `other` 尾桶，views 總和守恆）。stats endpoint 原本零測試，補 `test/stats.test.ts`。
2. **bot 過濾**：migration 0003 加 `views.is_bot`，`lib/bot.ts` 依 UA 分類，寫入時標記，stats 排除並單獨回報 `botViews`。缺 UA 視為真人（誤判成 bot 會靜默吃掉真實 view）。`test/bot.test.ts` 的 false-positive 案例抓到 `[Pinterest/iOS]` in-app 瀏覽器被誤殺。
3. **retention**：`VIEW_PII_RETENTION_SECONDS`（90 天）後 cron 把 raw ua/referrer 清成 NULL（列保留，view 數不變）；referrer 查詢同步限縮在窗內，否則被清空的列會偽裝成 `direct`。刪除 share 時立刻匿名化。stale pending 清理連帶刪 views。migration 0004 的 partial index 讓 sweep 的 no-op 執行是空探測。
4. **30 天趨勢**：`dailyViews`（UTC 日、補零、oldest first），stats 頁 CSS bar strip，MCP 回報近 7 日。

未做（留在上面的 backlog）：denormalized view counter——需重跑 /plan-eng-review。
