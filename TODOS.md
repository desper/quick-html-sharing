# TODOS

## Worker

### 版本歷史：edit 不直接覆寫

**What:** `POST /api/edit/:slug` 改為寫入新版本而非覆寫 R2，新增 `share_versions` 表 + 版本列表/還原 API。

**Why:** 同一份文件常更新多次，現況舊版即時丟失（`edit.ts` 直接 `HTML_BUCKET.put` 同一 key），使用者誤蓋無法救回。

**Context:** 2026-06-12 plan-eng-review（My Shares / Sync Key Registry）期間由使用者新增的需求。起點：`apps/worker/src/routes/edit.ts:49` 的覆寫邏輯。

**2026-08-09 更新：design 輪已完成，可直接實作。** 設計方案在 `~/.gstack/projects/desper-quick-html-sharing/lijianchang-chat-8fd9186a-design-20260808-235816.md`，已過 plan-eng-review 四段審查 + Codex outside voice，20 個決策全數裁定，含 T1-T10 實作任務與平行化 lane。測試計畫在同目錄 `-eng-review-test-plan-` 檔。

原案的 `share_versions` 表**被否決**（R2 list 的 uploaded/size 已是同一份資料，兩個真相來源在無交易的跨儲存寫入下必然漂移）；改為 `shares` 加兩欄（`latest_version`、`versions_pruned_below`）。三個當初未決的問題已裁：retention 保留 10 版、既有物件靠「v1 = 舊 key」零遷移、還原走雙路徑授權（含補齊 my-shares 與 MCP/skill 的入口，否則 owner key 路徑是死 API）。

**Effort:** L
**Priority:** P2
**Depends on:** 無（My Shares PR1-3 已出貨；design 已完成）

### R2 binding 若支援 versionId 就重新評估自管版本 key

**What:** 追蹤 Cloudflare 是否在 Workers R2 binding 上暴露 `versionId`。若有，版本歷史的自管邏輯（`lib/objectKey.ts` 的 v{n} key 佈局、retention sweep、孤兒回收）可能拿掉一大半。

**Why:** 這次為了繞過 binding 限制寫了相當多機制。典型的「平台補上了就該刪程式碼」債務，不記就永遠不會回頭看。

**Context:** 2026-08-09 plan-eng-review 查證：R2 object versioning 已 GA，但 Workers binding 的 `get`/`put`/`head`/`list`/`delete` 都沒有 versionId 參數，要讀特定版得在 Worker 內自簽 SigV4 走 S3 API。第二個阻礙是 R2 versioning 的 retention 是 bucket 層級 lifecycle 規則，管不到 per-share「保留最近 N 版」。**兩個阻礙要同時消失才值得換。** 起點：`lib/objectKey.ts` 的註解已記錄這個結論。

**Effort:** S（評估）/ M（若真的換掉）
**Priority:** P4
**Depends on:** 版本歷史出貨後 + CF 平台變化

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

### viewer analytics 補完（2026-08-08）

review 發現 `views` 表存了 `ip_hash` / `ua` / `referrer` 三欄但 stats 只跑 `COUNT(*)` + `MAX(viewed_at)`——資料收了沒用，README 賣的 "viewer analytics" 實際只是一個計數器。四步補完：

1. **unique viewers + referrer breakdown + stats 測試**：`ShareStats` 加 `uniqueViewers`、`referrers`（hostname 正規化，top 5 + `other` 尾桶，views 總和守恆）。stats endpoint 原本零測試，補 `test/stats.test.ts`。
2. **bot 過濾**：migration 0003 加 `views.is_bot`，`lib/bot.ts` 依 UA 分類，寫入時標記，stats 排除並單獨回報 `botViews`。缺 UA 視為真人（誤判成 bot 會靜默吃掉真實 view）。`test/bot.test.ts` 的 false-positive 案例抓到 `[Pinterest/iOS]` in-app 瀏覽器被誤殺。
3. **retention**：`VIEW_PII_RETENTION_SECONDS`（90 天）後 cron 把 raw ua/referrer 清成 NULL（列保留，view 數不變）；referrer 查詢同步限縮在窗內，否則被清空的列會偽裝成 `direct`。刪除 share 時立刻匿名化。stale pending 清理連帶刪 views。migration 0004 的 partial index 讓 sweep 的 no-op 執行是空探測。
4. **30 天趨勢**：`dailyViews`（UTC 日、補零、oldest first），stats 頁 CSS bar strip，MCP 回報近 7 日。

未做（留在上面的 backlog）：denormalized view counter——需重跑 /plan-eng-review。
