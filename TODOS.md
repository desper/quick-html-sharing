# TODOS

## Worker

### 版本歷史：edit 不直接覆寫

**What:** `POST /api/edit/:slug` 改為寫入新版本而非覆寫 R2，新增 `share_versions` 表 + 版本列表/還原 API。

**Why:** 同一份文件常更新多次，現況舊版即時丟失（`edit.ts` 直接 `HTML_BUCKET.put` 同一 key），使用者誤蓋無法救回。

**Context:** 2026-06-12 plan-eng-review（My Shares / Sync Key Registry）期間由使用者新增的需求。初步方向已寫入 design doc（`~/.gstack/projects/desper-quick-html-sharing/lijianchang-main-design-20260612-173834.md`「v-next Backlog」段）：`share_versions` 表（slug, version, created_at, content_size, r2_key）、R2 key 改 `shares/{slug}/v{n}.html`、share URL 永遠 serve 最新版、需 retention policy（保留最近 N 版）控 R2 成本、delete share 時清整組版本。實作前需自己跑一輪 design（retention、既有物件遷移、版本授權模型）。起點：`apps/worker/src/routes/edit.ts:50` 的覆寫邏輯。版本還原授權可直接重用 My Shares 的 owner-key 路徑。

**Effort:** L
**Priority:** P2
**Depends on:** My Shares PR1-3 出貨後

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

**Effort:** M
**Priority:** P4
**Depends on:** My Shares PR1-3 出貨後 + 用戶訊號

### 全站 a11y 基線套用（首頁 + stats 頁）

**What:** 把 My Shares 的五條 a11y 基線（aria-live 結果訊息、原生 label 關聯、disabled 說明、`:focus-visible` 描邊、contrast ≥ 4.5:1）套用到既有首頁（dropzone 鍵盤操作、result panel）與 stats 頁。

**Why:** 2026-06-13 plan-design-review D17 裁決：PR2 只規範 My Shares 頁，全站審查超出範圍。但首頁有同類問題（無 :focus-visible、dropzone 鍵盤未驗證、結果訊息無 aria-live），基線已定義好，套用成本低。

**Context:** 基線定義在 design doc「A11y 基線（D17 裁決）」段。非 WCAG 全面審查，只套五條。

**Effort:** S
**Priority:** P4
**Depends on:** My Shares PR2 出貨後（基線 pattern 先在新頁落地）

## Completed
